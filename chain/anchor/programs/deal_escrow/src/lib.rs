//! deal_escrow v2: pay-on-delivery escrow for the procurement layer, hardened with patterns from
//! ETHOnline 2026 projects (see contracts/chain.md for the mapping):
//!
//! - BuyerPolicy (LedgerMind, NotYet): budget per period, max price, seller allowlist, a second
//!   approver above a threshold. Checked by the program when a deal is opened.
//! - Seller accept + stake (Pact): the seller commits to the terms and posts a stake before work.
//! - Invoice match (Procure's PO/receipt/invoice, enforced here instead of off chain): the seller's
//!   invoice must be within the order amount ± tolerance; release names the delivery hash it
//!   approves and pays the invoice, refunding the rest.
//! - Challenge + verifier (Reckn, Recourse, Clawback): within the review window the buyer may
//!   challenge with a bond; a verifier key fixed at creation decides. A verdict that never comes
//!   refunds the buyer instead of locking funds (the gap in PROVE and Clawback).
//! - Slashing is computed by this program from on-chain time and state only, never from a flag a
//!   caller passes in (Xenia's resolveDispute let anyone slash).
//!
//! - Seller reputation (Assay): SellerRep and RepPair accounts, written only by `settle`, so a
//!   reputation change always comes with a real payout. Keyed by mint, so deals settled in a
//!   token the seller minted themselves never mix with (or inflate) the USDC record. Scoring (min deals, min distinct buyers,
//!   concentration) is a pure function in core; the program only keeps honest counts.
//!
//! - Listing registry (OnchainRouter's single registry, PLAN §2.2): a seller lists data, a
//!   service or an agent-team blueprint with a content hash; an independent assessor attests a
//!   report hash. Changing the content clears the attestation. A deal opened from a Data listing
//!   must be delivered with exactly the listed content hash (checked through its DealLink).
//!
//! - Assessor registry: only assessors on an on-chain list (kept by the program's upgrade
//!   authority) can be named on a listing or attest one, and deals and agent payments only trust
//!   attestations from assessors still on the list. A seller cannot attest its own listing through
//!   a second key it holds.
//! - Missions and agent mandates (PLAN §2.3; LedgerMind payment intents, Batas mandates, Cordon's
//!   shared budget): a buyer funds a mission budget, gives each team agent a mandate (caps, payee
//!   list, expiry, revocable in one transaction) and approves every stage's plan before any agent
//!   can spend in it. Agents never hold tokens: every token they move goes through `agent_spend`
//!   or through an escrow deal the program opens for the mission (`agent_open_deal`), and every
//!   such movement counts against every cap.
//!
//! Tokens leave the vault only in `settle`, after every check, and only to the deal's own buyer and
//! seller token accounts; a refused instruction moves nothing.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{bpf_loader_upgradeable, instruction::Instruction, program::invoke_signed};
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV");

pub const DEAL_SEED: &[u8] = b"deal";
pub const POLICY_SEED: &[u8] = b"policy";
pub const REP_SEED: &[u8] = b"rep";
pub const LISTING_SEED: &[u8] = b"listing";
pub const LINK_SEED: &[u8] = b"link";
pub const MISSION_SEED: &[u8] = b"mission";
pub const MISSION_AUTH_SEED: &[u8] = b"mission_auth";
pub const MANDATE_SEED: &[u8] = b"mandate";
pub const MISSION_DEAL_SEED: &[u8] = b"mission_deal";
pub const MAX_STAGES: usize = 8;
pub const MAX_PAYEES: usize = 8;
pub const ASSESSORS_SEED: &[u8] = b"assessors";
pub const MAX_ASSESSORS: usize = 16;
pub const MAX_WINDOW_SECS: i64 = 30 * 86_400;
pub const MIN_RESOLVE_SECS: i64 = 60;
pub const MAX_TOLERANCE_BPS: u16 = 2_000;
pub const MAX_BOND_BPS: u16 = 5_000;
pub const MAX_ALLOWED_SELLERS: usize = 8;
const BPS: u128 = 10_000;

#[program]
pub mod deal_escrow {
    use super::*;

    /// Buyer creates their spending policy. Deals can only be opened through a policy.
    pub fn init_policy(ctx: Context<InitPolicy>, params: PolicyParams) -> Result<()> {
        params.validate()?;
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.policy.set_inner(BuyerPolicy {
            buyer: ctx.accounts.buyer.key(),
            mint: ctx.accounts.mint.key(),
            period_secs: params.period_secs,
            period_start: now,
            period_budget: params.period_budget,
            period_spent: 0,
            max_price: params.max_price,
            approval_threshold: params.approval_threshold,
            approver: params.approver,
            allow_any_seller: params.allow_any_seller,
            allowed_sellers: params.allowed_sellers,
            bump: ctx.bumps.policy,
        });
        Ok(())
    }

    /// Buyer changes their policy. Spent-in-period is kept, so a change can't reset the budget.
    pub fn update_policy(ctx: Context<UpdatePolicy>, params: PolicyParams) -> Result<()> {
        params.validate()?;
        let p = &mut ctx.accounts.policy;
        p.period_secs = params.period_secs;
        p.period_budget = params.period_budget;
        p.max_price = params.max_price;
        p.approval_threshold = params.approval_threshold;
        p.approver = params.approver;
        p.allow_any_seller = params.allow_any_seller;
        p.allowed_sellers = params.allowed_sellers;
        Ok(())
    }

    /// Buyer opens a deal and moves the order amount into the vault. Policy is checked first.
    pub fn create_deal(ctx: Context<CreateDeal>, deal_id: u64, p: DealParams) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let buyer = ctx.accounts.buyer.key();
        let seller = ctx.accounts.seller.key();
        require!(p.amount > 0, DealError::ZeroAmount);
        require!(p.deadline > now, DealError::DeadlineInPast);
        require!(p.deadline - now <= MAX_WINDOW_SECS, DealError::DeadlineTooFar);
        require!((0..=MAX_WINDOW_SECS).contains(&p.review_secs), DealError::BadReviewWindow);
        require!(p.tolerance_bps <= MAX_TOLERANCE_BPS, DealError::BadTolerance);
        require!(p.bond_bps <= MAX_BOND_BPS, DealError::BadBond);
        require_keys_neq!(buyer, seller, DealError::SelfDeal);
        if p.verifier != Pubkey::default() {
            // The judge must be independent of both parties.
            require!(p.verifier != buyer && p.verifier != seller, DealError::VerifierNotIndependent);
            require!((MIN_RESOLVE_SECS..=MAX_WINDOW_SECS).contains(&p.resolve_secs), DealError::BadResolveWindow);
        }

        // Policy (LedgerMind / NotYet). Fail closed: an unlisted seller is refused unless the
        // buyer explicitly allowed any seller.
        let policy = &mut ctx.accounts.policy;
        require_keys_eq!(policy.mint, ctx.accounts.mint.key(), DealError::PolicyMintMismatch);
        require!(
            policy.allow_any_seller || policy.allowed_sellers.contains(&seller),
            DealError::SellerNotAllowed
        );
        require!(p.amount <= policy.max_price, DealError::OverMaxPrice);
        if now >= policy.period_start.saturating_add(policy.period_secs) {
            policy.period_start = now;
            policy.period_spent = 0;
        }
        let spent = policy.period_spent.checked_add(p.amount).ok_or(DealError::MathOverflow)?;
        require!(spent <= policy.period_budget, DealError::OverPeriodBudget);
        if p.amount > policy.approval_threshold {
            let approver = ctx.accounts.approver.as_ref().ok_or(DealError::ApprovalRequired)?;
            require!(policy.approver != Pubkey::default(), DealError::ApprovalRequired);
            require_keys_eq!(approver.key(), policy.approver, DealError::ApprovalRequired);
        }
        policy.period_spent = spent;
        init_rep(&mut ctx.accounts.seller_rep, &mut ctx.accounts.rep_pair, seller, buyer, ctx.accounts.mint.key(), ctx.bumps.seller_rep, ctx.bumps.rep_pair);

        // Opened from a listing: the listing must be live, attested and match the deal exactly.
        // The DealLink binds the deal to it so delivery and settlement can check it later.
        match (&ctx.accounts.listing, &mut ctx.accounts.link) {
            (Some(listing), Some(link)) => {
                require!(listing.active, DealError::ListingInactive);
                require!(listing.assessed_at != 0, DealError::ListingNotAttested);
                require_keys_eq!(listing.seller, seller, DealError::ListingMismatch);
                require_keys_eq!(listing.mint, ctx.accounts.mint.key(), DealError::ListingMismatch);
                require!(listing.price == p.amount, DealError::ListingMismatch);
                // The buyer names the content it saw; a swap racing the purchase is refused.
                require!(listing.content_hash == p.listing_content_hash, DealError::ListingMismatch);
                let registry = ctx.accounts.registry.as_ref().ok_or(DealError::AssessorNotRegistered)?;
                require!(registry.assessors.contains(&listing.assessor), DealError::AssessorNotRegistered);
                link.set_inner(DealLink {
                    deal: ctx.accounts.deal.key(),
                    listing: listing.key(),
                    expected_delivery_hash: if listing.kind == ListingKind::Data { listing.content_hash } else { [0; 32] },
                    listing_created_at: listing.created_at,
                    bump: ctx.bumps.link.ok_or(DealError::ListingMismatch)?,
                });
            }
            (None, None) => {}
            _ => return err!(DealError::ListingMismatch),
        }

        ctx.accounts.deal.set_inner(Deal {
            buyer,
            seller,
            mint: ctx.accounts.mint.key(),
            verifier: p.verifier,
            deal_id,
            amount: p.amount,
            invoice_amount: 0,
            tolerance_bps: p.tolerance_bps,
            stake_required: p.stake_required,
            stake_posted: 0,
            bond_bps: p.bond_bps,
            bond_posted: 0,
            deadline: p.deadline,
            review_secs: p.review_secs,
            resolve_secs: p.resolve_secs,
            terms_hash: p.terms_hash,
            delivery_hash: [0; 32],
            created_at: now,
            accepted_at: 0,
            delivered_at: 0,
            challenged_at: 0,
            status: DealStatus::Open,
            bump: ctx.bumps.deal,
        });

        move_in(
            &ctx.accounts.buyer_token,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.buyer,
            &ctx.accounts.token_program,
            p.amount,
        )?;
        emit!(DealEvent { deal: ctx.accounts.deal.key(), status: DealStatus::Open });
        Ok(())
    }

    /// The program's upgrade authority sets the list of assessors whose attestations count.
    /// Replacing the list is immediate: deals and agent payments re-check it every time.
    pub fn set_assessors(ctx: Context<SetAssessors>, assessors: Vec<Pubkey>) -> Result<()> {
        // UpgradeableLoaderState::ProgramData header: u32 tag (3), u64 slot, Option<Pubkey> authority.
        let data = ctx.accounts.program_data.try_borrow_data()?;
        require!(data.len() >= 45 && data[0..4] == 3u32.to_le_bytes() && data[12] == 1, DealError::Unauthorized);
        require!(data[13..45] == ctx.accounts.authority.key().to_bytes(), DealError::Unauthorized);
        drop(data);
        require!(assessors.len() <= MAX_ASSESSORS, DealError::BadListing);
        require!(!assessors.contains(&Pubkey::default()), DealError::BadListing);
        let r = &mut ctx.accounts.registry;
        r.authority = ctx.accounts.authority.key();
        r.assessors = assessors;
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Seller lists data, a service or a team blueprint. It starts unattested; deals can only be
    /// opened from it once its assessor (never the seller) has attested a report.
    pub fn create_listing(ctx: Context<CreateListing>, listing_id: u64, p: ListingParams) -> Result<()> {
        let seller = ctx.accounts.seller.key();
        require!(p.price > 0, DealError::ZeroAmount);
        require!(p.content_hash != [0; 32], DealError::BadListing);
        require!(p.assessor != Pubkey::default() && p.assessor != seller, DealError::AssessorNotIndependent);
        require!(ctx.accounts.registry.assessors.contains(&p.assessor), DealError::AssessorNotRegistered);
        ctx.accounts.listing.set_inner(Listing {
            seller,
            listing_id,
            kind: p.kind,
            mint: ctx.accounts.mint.key(),
            price: p.price,
            content_hash: p.content_hash,
            meta_hash: p.meta_hash,
            terms_template_hash: p.terms_template_hash,
            assessor: p.assessor,
            report_hash: [0; 32],
            assessed_at: 0,
            active: true,
            sales: 0,
            created_at: Clock::get()?.unix_timestamp,
            bump: ctx.bumps.listing,
        });
        Ok(())
    }

    /// The listing's assessor attests the report it produced for exactly the listed content.
    pub fn attest_listing(ctx: Context<AttestListing>, content_hash: [u8; 32], report_hash: [u8; 32]) -> Result<()> {
        let l = &mut ctx.accounts.listing;
        require_keys_eq!(ctx.accounts.assessor.key(), l.assessor, DealError::NotAssessor);
        require!(ctx.accounts.registry.assessors.contains(&l.assessor), DealError::AssessorNotRegistered);
        // Bound to the content the assessor saw, so a swap racing the attestation is refused.
        require!(l.content_hash == content_hash, DealError::ListingMismatch);
        require!(report_hash != [0; 32], DealError::BadListing);
        l.report_hash = report_hash;
        l.assessed_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Seller changes price or availability freely; changing what is sold (content or metadata)
    /// clears the attestation, so it must be assessed again before anyone can buy it.
    pub fn update_listing(ctx: Context<UpdateListing>, u: ListingUpdate) -> Result<()> {
        let l = &mut ctx.accounts.listing;
        if let Some(price) = u.price {
            require!(price > 0, DealError::ZeroAmount);
            l.price = price;
        }
        if let Some(active) = u.active {
            l.active = active;
        }
        let mut changed = false;
        if let Some(h) = u.content_hash {
            require!(h != [0; 32], DealError::BadListing);
            changed |= h != l.content_hash;
            l.content_hash = h;
        }
        if let Some(h) = u.meta_hash {
            changed |= h != l.meta_hash;
            l.meta_hash = h;
        }
        if changed {
            l.report_hash = [0; 32];
            l.assessed_at = 0;
        }
        Ok(())
    }

    /// Seller removes a listing and gets its rent back. Deals already opened from it keep their
    /// DealLink (which holds the expected delivery hash), so they are unaffected.
    pub fn close_listing(_ctx: Context<CloseListing>) -> Result<()> {
        Ok(())
    }

    /// Buyer withdraws an offer the seller has not accepted. Full refund, budget credited back.
    pub fn cancel(ctx: Context<Settle>) -> Result<()> {
        let d = &ctx.accounts.deal;
        require!(d.status == DealStatus::Open, DealError::WrongStatus);
        require_keys_eq!(ctx.accounts.actor.key(), d.buyer, DealError::Unauthorized);
        let to_buyer = total_held(d)?;
        settle(ctx.accounts, &ctx.bumps, 0, to_buyer, DealStatus::Cancelled, true)
    }

    /// Seller accepts the terms and posts the stake (Pact). Work starts only after this.
    pub fn accept(ctx: Context<Accept>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &ctx.accounts.deal;
        require!(d.status == DealStatus::Open, DealError::WrongStatus);
        require!(now <= d.deadline, DealError::DeadlinePassed);
        let stake = d.stake_required;
        if stake > 0 {
            move_in(
                &ctx.accounts.seller_token,
                &ctx.accounts.vault,
                &ctx.accounts.mint,
                &ctx.accounts.seller,
                &ctx.accounts.token_program,
                stake,
            )?;
        }
        let d = &mut ctx.accounts.deal;
        d.stake_posted = stake;
        d.accepted_at = now;
        d.status = DealStatus::Funded;
        emit!(DealEvent { deal: d.key(), status: DealStatus::Funded });
        Ok(())
    }

    /// Seller records the delivery hash and invoices. The invoice must match the order amount
    /// within the agreed tolerance (Procure's match, enforced on chain).
    pub fn submit_delivery(ctx: Context<SubmitDelivery>, delivery_hash: [u8; 32], invoice_amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &mut ctx.accounts.deal;
        require!(d.status == DealStatus::Funded, DealError::WrongStatus);
        require!(now <= d.deadline, DealError::DeadlinePassed);
        require!(delivery_hash != [0; 32], DealError::EmptyDelivery);
        require!(invoice_matches(d.amount, invoice_amount, d.tolerance_bps), DealError::InvoiceMismatch);
        if let Some(link) = read_link(&ctx.accounts.link)? {
            if link.expected_delivery_hash != [0; 32] {
                require!(delivery_hash == link.expected_delivery_hash, DealError::NotListedContent);
            }
        }
        d.delivery_hash = delivery_hash;
        d.invoice_amount = invoice_amount;
        d.delivered_at = now;
        d.status = DealStatus::Delivered;
        emit!(DealEvent { deal: d.key(), status: DealStatus::Delivered });
        Ok(())
    }

    /// Buyer approves exactly the delivery it names (approval bound to the hash, AutoVoyage).
    pub fn release(ctx: Context<Settle>, expected_delivery_hash: [u8; 32]) -> Result<()> {
        let d = &ctx.accounts.deal;
        require!(d.status == DealStatus::Delivered, DealError::WrongStatus);
        require_keys_eq!(ctx.accounts.actor.key(), d.buyer, DealError::Unauthorized);
        require!(d.delivery_hash == expected_delivery_hash, DealError::DeliveryMismatch);
        let (to_seller, to_buyer) = pass_split(d, false)?;
        settle(ctx.accounts, &ctx.bumps, to_seller, to_buyer, DealStatus::Released, false)
    }

    /// After the review window with no challenge, anyone may settle to the seller (buyer silence
    /// = acceptance). Funds can only go to the deal's own seller and buyer token accounts.
    pub fn claim(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &ctx.accounts.deal;
        require!(d.status == DealStatus::Delivered, DealError::WrongStatus);
        require!(now >= d.delivered_at.saturating_add(d.review_secs), DealError::ReviewWindowOpen);
        let (to_seller, to_buyer) = pass_split(d, false)?;
        settle(ctx.accounts, &ctx.bumps, to_seller, to_buyer, DealStatus::Claimed, false)
    }

    /// Buyer disputes the delivery inside the review window, posting a bond (Reckn / Recourse).
    /// Only possible when the deal names a verifier, so a challenge can always be decided.
    pub fn challenge(ctx: Context<Challenge>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &ctx.accounts.deal;
        require!(d.status == DealStatus::Delivered, DealError::WrongStatus);
        require!(d.verifier != Pubkey::default(), DealError::NoVerifier);
        require!(now < d.delivered_at.saturating_add(d.review_secs), DealError::ReviewWindowClosed);
        let bond = bps_of(d.amount, d.bond_bps)?;
        if bond > 0 {
            move_in(
                &ctx.accounts.buyer_token,
                &ctx.accounts.vault,
                &ctx.accounts.mint,
                &ctx.accounts.buyer,
                &ctx.accounts.token_program,
                bond,
            )?;
        }
        let d = &mut ctx.accounts.deal;
        d.bond_posted = bond;
        d.challenged_at = now;
        d.status = DealStatus::Challenged;
        emit!(DealEvent { deal: d.key(), status: DealStatus::Challenged });
        Ok(())
    }

    /// The deal's verifier decides a challenge within the resolve window.
    /// Pass: seller paid as on release, plus the buyer's bond. Fail: buyer gets everything back
    /// and the seller's stake is slashed to the buyer.
    pub fn resolve(ctx: Context<Settle>, delivery_ok: bool) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &ctx.accounts.deal;
        require!(d.status == DealStatus::Challenged, DealError::WrongStatus);
        require_keys_eq!(ctx.accounts.actor.key(), d.verifier, DealError::NotVerifier);
        require!(now <= d.challenged_at.saturating_add(d.resolve_secs), DealError::ResolveWindowClosed);
        if delivery_ok {
            let (to_seller, to_buyer) = pass_split(d, true)?;
            settle(ctx.accounts, &ctx.bumps, to_seller, to_buyer, DealStatus::VerifiedPass, false)
        } else {
            let to_buyer = total_held(d)?;
            settle(ctx.accounts, &ctx.bumps, 0, to_buyer, DealStatus::VerifiedFail, true)
        }
    }

    /// No verdict within the resolve window: anyone may refund the buyer (order + bond); the
    /// seller gets the stake back, since the missing verdict is not the seller's fault. Its own
    /// status (NoVerdict) keeps it distinguishable from a missed-deadline refund on chain.
    pub fn timeout_refund(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &ctx.accounts.deal;
        require!(d.status == DealStatus::Challenged, DealError::WrongStatus);
        require!(now > d.challenged_at.saturating_add(d.resolve_secs), DealError::ResolveWindowOpen);
        let to_buyer = d.amount.checked_add(d.bond_posted).ok_or(DealError::MathOverflow)?;
        let to_seller = d.stake_posted;
        settle(ctx.accounts, &ctx.bumps, to_seller, to_buyer, DealStatus::NoVerdict, true)
    }

    /// Deadline passed without delivery: anyone may refund. If the seller had accepted, the
    /// stake is slashed to the buyer (Pact's late penalty; computed from chain time, not a flag).
    pub fn refund(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &ctx.accounts.deal;
        require!(
            d.status == DealStatus::Funded || d.status == DealStatus::Open,
            DealError::WrongStatus
        );
        require!(now > d.deadline, DealError::DeadlineNotReached);
        let to_buyer = total_held(d)?;
        settle(ctx.accounts, &ctx.bumps, 0, to_buyer, DealStatus::Refunded, true)
    }

    /// Buyer funds a mission: the budget moves into a vault owned by the mission's authority PDA,
    /// charged to the buyer's policy like a deal (period budget, approver above the threshold).
    /// The authority also gets its own policy so deals opened for the mission obey the buyer's
    /// seller allowlist and max price. `rent_lamports` pays rent for those deals.
    pub fn create_mission(ctx: Context<CreateMission>, mission_id: u64, p: MissionParams) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(p.budget > 0, DealError::ZeroAmount);
        require!(p.expires_at > now && p.expires_at - now <= MAX_WINDOW_SECS, DealError::BadMission);
        require!(!p.stage_caps.is_empty() && p.stage_caps.len() <= MAX_STAGES, DealError::BadMission);
        for c in &p.stage_caps {
            require!(*c > 0 && *c <= p.budget, DealError::BadMission);
        }
        // The buyer fixes the protections of every deal its agents open (a verifier it trusts, review and
        // resolve windows no shorter than these, invoice tolerance no wider): agents cannot weaken them.
        require!(p.verifier != Pubkey::default() && p.verifier != ctx.accounts.buyer.key(), DealError::BadMission);
        require!((0..=MAX_WINDOW_SECS).contains(&p.min_review_secs), DealError::BadMission);
        require!((MIN_RESOLVE_SECS..=MAX_WINDOW_SECS).contains(&p.min_resolve_secs), DealError::BadMission);
        require!(p.max_tolerance_bps <= MAX_TOLERANCE_BPS, DealError::BadMission);
        let policy = &mut ctx.accounts.policy;
        require_keys_eq!(policy.mint, ctx.accounts.mint.key(), DealError::PolicyMintMismatch);
        if now >= policy.period_start.saturating_add(policy.period_secs) {
            policy.period_start = now;
            policy.period_spent = 0;
        }
        let spent = policy.period_spent.checked_add(p.budget).ok_or(DealError::MathOverflow)?;
        require!(spent <= policy.period_budget, DealError::OverPeriodBudget);
        if p.budget > policy.approval_threshold {
            let approver = ctx.accounts.approver.as_ref().ok_or(DealError::ApprovalRequired)?;
            require!(policy.approver != Pubkey::default(), DealError::ApprovalRequired);
            require_keys_eq!(approver.key(), policy.approver, DealError::ApprovalRequired);
        }
        policy.period_spent = spent;

        let auth = ctx.accounts.mission_auth.key();
        ctx.accounts.auth_policy.set_inner(BuyerPolicy {
            buyer: auth,
            mint: ctx.accounts.mint.key(),
            period_secs: 366 * 86_400,
            period_start: now,
            period_budget: p.budget,
            period_spent: 0,
            max_price: policy.max_price.min(p.budget),
            // Human gates are the stage approvals; there is no co-signer for agent deals.
            approval_threshold: u64::MAX,
            approver: Pubkey::default(),
            allow_any_seller: policy.allow_any_seller,
            allowed_sellers: policy.allowed_sellers.clone(),
            bump: ctx.bumps.auth_policy,
        });
        ctx.accounts.mission.set_inner(Mission {
            buyer: ctx.accounts.buyer.key(),
            mint: ctx.accounts.mint.key(),
            mission_id,
            team_listing: p.team_listing,
            terms_hash: p.terms_hash,
            budget: p.budget,
            spent: 0,
            mandate_caps: 0,
            mandate_count: 0,
            mandates_digest: [0; 32],
            mandates_locked: false,
            stages: p.stage_caps.iter().map(|c| Stage { cap: *c, spent: 0, plan_hash: [0; 32], approved_at: 0 }).collect(),
            current_stage: 0,
            expires_at: p.expires_at,
            created_at: now,
            closed: false,
            verifier: p.verifier,
            min_review_secs: p.min_review_secs,
            min_resolve_secs: p.min_resolve_secs,
            max_tolerance_bps: p.max_tolerance_bps,
            auth_bump: ctx.bumps.mission_auth,
            bump: ctx.bumps.mission,
        });
        move_in(&ctx.accounts.buyer_token, &ctx.accounts.vault, &ctx.accounts.mint, &ctx.accounts.buyer, &ctx.accounts.token_program, p.budget)?;
        if p.rent_lamports > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to: ctx.accounts.mission_auth.to_account_info(),
                    },
                ),
                p.rent_lamports,
            )?;
        }
        Ok(())
    }

    /// Buyer gives one agent a mandate. Allowed only before the first stage is approved; the
    /// running digest of all mandates is what the buyer's first approval signs (Batas: the
    /// mandate set is the terms).
    pub fn add_mandate(ctx: Context<AddMandate>, p: MandateParams) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.mission;
        require!(!m.closed, DealError::MissionClosed);
        require!(!m.mandates_locked, DealError::MandatesLocked);
        require!(p.agent != Pubkey::default() && p.agent != m.buyer, DealError::BadMandate);
        require!(p.cap > 0 && p.per_tx_cap > 0 && p.per_tx_cap <= p.cap, DealError::BadMandate);
        require!(p.payees.len() <= MAX_PAYEES, DealError::BadMandate);
        // Every stage the agent may spend in must exist.
        require!(p.stage_mask != 0 && (p.stage_mask as u32) < (1u32 << m.stages.len()), DealError::BadMandate);
        require!(p.expires_at > now && p.expires_at <= m.expires_at, DealError::BadMandate);
        let caps = m.mandate_caps.checked_add(p.cap).ok_or(DealError::MathOverflow)?;
        require!(caps <= m.budget, DealError::OverMissionBudget);
        m.mandate_caps = caps;
        m.mandate_count = m.mandate_count.checked_add(1).ok_or(DealError::MathOverflow)?;
        m.mandates_digest = mandate_digest(&m.mandates_digest, &p);
        ctx.accounts.mandate.set_inner(Mandate {
            mission: m.key(),
            agent: p.agent,
            role_hash: p.role_hash,
            cap: p.cap,
            per_tx_cap: p.per_tx_cap,
            spent: 0,
            payees: p.payees,
            stage_mask: p.stage_mask,
            expires_at: p.expires_at,
            revoked: false,
            bump: ctx.bumps.mandate,
        });
        Ok(())
    }

    /// The human gate. No agent spends in a stage until the buyer approves its plan hash (plus
    /// the policy approver when the stage cap is above the threshold). The first approval also
    /// names the mandate digest it saw and locks the mandate set.
    pub fn approve_stage(ctx: Context<ApproveStage>, stage: u8, plan_hash: [u8; 32], mandates_digest: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.mission;
        require!(!m.closed, DealError::MissionClosed);
        require!(now < m.expires_at, DealError::MissionExpired);
        require!(plan_hash != [0; 32], DealError::BadStage);
        require!(mandates_digest == m.mandates_digest, DealError::MandatesChanged);
        let s = stage as usize;
        require!(s < m.stages.len(), DealError::BadStage);
        if !m.mandates_locked {
            require!(s == 0, DealError::BadStage);
            m.mandates_locked = true;
        } else {
            let cur = m.current_stage as usize;
            require!(m.stages[cur].approved_at != 0 && s == cur + 1, DealError::BadStage);
        }
        if m.stages[s].cap > ctx.accounts.policy.approval_threshold {
            let approver = ctx.accounts.approver.as_ref().ok_or(DealError::ApprovalRequired)?;
            require!(ctx.accounts.policy.approver != Pubkey::default(), DealError::ApprovalRequired);
            require_keys_eq!(approver.key(), ctx.accounts.policy.approver, DealError::ApprovalRequired);
        }
        m.stages[s].plan_hash = plan_hash;
        m.stages[s].approved_at = now;
        m.current_stage = stage;
        Ok(())
    }

    /// An agent pays an allowed payee straight from the mission vault, within every cap.
    /// `receipt_hash` commits to the off-chain context that justified the payment (LedgerMind).
    pub fn agent_spend(ctx: Context<AgentSpend>, amount: u64, receipt_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let payee = ctx.accounts.payee_token.owner;
        payee_allowed(&ctx.accounts.mandate, payee, ctx.accounts.listing.as_deref().map(|l| &**l), ctx.accounts.registry.as_deref().map(|r| &**r), ctx.accounts.mint.key())?;
        check_spend(&mut ctx.accounts.mission, &mut ctx.accounts.mandate, amount, now)?;
        let mission_key = ctx.accounts.mission.key();
        let seeds: &[&[u8]] = &[MISSION_AUTH_SEED, mission_key.as_ref(), &[ctx.accounts.mission.auth_bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.payee_token.to_account_info(),
                    authority: ctx.accounts.mission_auth.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(SpendEvent { mission: mission_key, agent: ctx.accounts.agent.key(), payee, amount, receipt_hash });
        Ok(())
    }

    /// An agent buys under escrow: the program opens a normal deal with the mission's authority
    /// as buyer (re-entering `create_deal`, so every deal rule applies), after counting the
    /// amount against every cap and checking the seller is an allowed payee.
    pub fn agent_open_deal(ctx: Context<AgentOpenDeal>, deal_id: u64, p: DealParams, receipt_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let seller = ctx.accounts.seller.key();
        payee_allowed(&ctx.accounts.mandate, seller, ctx.accounts.listing.as_deref().map(|l| &**l), ctx.accounts.registry.as_deref().map(|r| &**r), ctx.accounts.mint.key())?;
        {
            let m = &ctx.accounts.mission;
            require!(p.verifier == m.verifier, DealError::DealTermsNotAllowed);
            require!(p.review_secs >= m.min_review_secs, DealError::DealTermsNotAllowed);
            require!(p.resolve_secs >= m.min_resolve_secs, DealError::DealTermsNotAllowed);
            require!(p.tolerance_bps <= m.max_tolerance_bps, DealError::DealTermsNotAllowed);
        }
        check_spend(&mut ctx.accounts.mission, &mut ctx.accounts.mandate, p.amount, now)?;
        let a = &ctx.accounts;
        let metas = crate::accounts::CreateDeal {
            buyer: a.mission_auth.key(),
            seller,
            approver: None,
            policy: a.auth_policy.key(),
            mint: a.mint.key(),
            buyer_token: a.vault.key(),
            deal: a.deal.key(),
            seller_rep: a.seller_rep.key(),
            rep_pair: a.rep_pair.key(),
            listing: a.listing.as_ref().map(|l| l.key()),
            link: a.link.as_ref().map(|l| l.key()),
            registry: a.registry.as_ref().map(|r| r.key()),
            vault: a.deal_vault.key(),
            token_program: a.token_program.key(),
            associated_token_program: a.associated_token_program.key(),
            system_program: a.system_program.key(),
        }
        .to_account_metas(None);
        let mut infos = vec![
            a.mission_auth.to_account_info(), a.seller.to_account_info(), a.auth_policy.to_account_info(),
            a.mint.to_account_info(), a.vault.to_account_info(), a.deal.to_account_info(), a.seller_rep.to_account_info(),
            a.rep_pair.to_account_info(), a.deal_vault.to_account_info(), a.token_program.to_account_info(),
            a.associated_token_program.to_account_info(), a.system_program.to_account_info(), a.deal_program.to_account_info(),
        ];
        if let Some(l) = &a.listing { infos.push(l.to_account_info()); }
        if let Some(l) = &a.link { infos.push(l.to_account_info()); }
        if let Some(r) = &a.registry { infos.push(r.to_account_info()); }
        let ix = Instruction { program_id: crate::ID, accounts: metas, data: crate::instruction::CreateDeal { deal_id, p: p.clone() }.data() };
        let mission_key = a.mission.key();
        let auth_seeds: &[&[u8]] = &[MISSION_AUTH_SEED, mission_key.as_ref(), &[a.mission.auth_bump]];
        invoke_signed(&ix, &infos, &[auth_seeds])?;
        // Record who opened it: only this agent (or the buyer) may release or challenge it later.
        let deal_key = a.deal.key();
        let md_seeds: &[&[u8]] = &[MISSION_DEAL_SEED, deal_key.as_ref(), &[ctx.bumps.mission_deal]];
        let space = 8 + MissionDeal::INIT_SPACE;
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                a.system_program.key(),
                anchor_lang::system_program::CreateAccount { from: a.mission_auth.to_account_info(), to: a.mission_deal.to_account_info() },
                &[auth_seeds, md_seeds],
            ),
            Rent::get()?.minimum_balance(space),
            space as u64,
            &crate::ID,
        )?;
        let record = MissionDeal { mission: mission_key, deal: deal_key, agent: a.agent.key(), bump: ctx.bumps.mission_deal };
        record.try_serialize(&mut &mut a.mission_deal.try_borrow_mut_data()?[..])?;
        emit!(SpendEvent { mission: mission_key, agent: a.agent.key(), payee: seller, amount: p.amount, receipt_hash });
        Ok(())
    }

    /// Releases a mission deal (re-entering `release` as the mission's authority). The buyer may always
    /// do this, even after revoking agents or closing the mission; an agent only for a deal it opened
    /// itself, with a live mandate. Moves nothing out of the mission vault, so no cap is charged.
    pub fn agent_release(ctx: Context<AgentSettle>, expected_delivery_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        mission_actor(&ctx.accounts.mission, &ctx.accounts.mission_deal, ctx.accounts.agent.key(), ctx.accounts.mandate.as_deref().map(|m| &**m), now)?;
        let a = &ctx.accounts;
        let data = crate::instruction::Release { expected_delivery_hash }.data();
        invoke_settle(a, data)
    }

    /// Challenges a mission deal: the buyer at any time (even after revoking agents or closing the
    /// mission), or the agent that opened it, with a live mandate. The bond leaves the mission vault, so
    /// it counts as spend: against every cap for an agent, against the mission budget for the buyer.
    pub fn agent_challenge(ctx: Context<AgentChallenge>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deal = read_deal(&ctx.accounts.deal)?;
        require_keys_eq!(deal.buyer, ctx.accounts.mission_auth.key(), DealError::Unauthorized);
        let actor = ctx.accounts.agent.key();
        let by_buyer = mission_actor(&ctx.accounts.mission, &ctx.accounts.mission_deal, actor, ctx.accounts.mandate.as_deref().map(|m| &**m), now)?;
        let bond = bps_of(deal.amount, deal.bond_bps)?;
        if bond > 0 {
            if by_buyer {
                let m = &mut ctx.accounts.mission;
                let spent = m.spent.checked_add(bond).ok_or(DealError::MathOverflow)?;
                require!(spent <= m.budget, DealError::OverMissionBudget);
                m.spent = spent;
            } else {
                let mandate = ctx.accounts.mandate.as_mut().ok_or(DealError::Unauthorized)?;
                check_spend(&mut ctx.accounts.mission, mandate, bond, now)?;
            }
        }
        let a = &ctx.accounts;
        let metas = crate::accounts::Challenge {
            buyer: a.mission_auth.key(),
            deal: a.deal.key(),
            mint: a.mint.key(),
            vault: a.deal_vault.key(),
            buyer_token: a.vault.key(),
            token_program: a.token_program.key(),
        }
        .to_account_metas(None);
        let infos = vec![
            a.mission_auth.to_account_info(), a.deal.to_account_info(), a.mint.to_account_info(), a.deal_vault.to_account_info(),
            a.vault.to_account_info(), a.token_program.to_account_info(), a.deal_program.to_account_info(),
        ];
        let ix = Instruction { program_id: crate::ID, accounts: metas, data: crate::instruction::Challenge {}.data() };
        let mission_key = a.mission.key();
        invoke_signed(&ix, &infos, &[&[MISSION_AUTH_SEED, mission_key.as_ref(), &[a.mission.auth_bump]]])?;
        Ok(())
    }

    /// Buyer revokes one agent in one transaction: its next spend, deal or release is refused,
    /// and its runner sees the flag and stops (PLAN §6.2).
    pub fn revoke_mandate(ctx: Context<RevokeMandate>) -> Result<()> {
        ctx.accounts.mandate.revoked = true;
        Ok(())
    }

    /// Buyer at any time, anyone after expiry: returns what is in the mission vault (and the
    /// authority's unused SOL) to the buyer and credits the unspent budget back to the policy.
    /// Callable again later to sweep refunds from the mission's deals.
    pub fn close_mission(ctx: Context<CloseMission>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &ctx.accounts.mission;
        require!(ctx.accounts.actor.key() == m.buyer || now >= m.expires_at, DealError::Unauthorized);
        let mission_key = m.key();
        let bump = m.auth_bump;
        let seeds: &[&[u8]] = &[MISSION_AUTH_SEED, mission_key.as_ref(), &[bump]];
        let amount = ctx.accounts.vault.amount;
        if amount > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.buyer_token.to_account_info(),
                        authority: ctx.accounts.mission_auth.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
                ctx.accounts.mint.decimals,
            )?;
        }
        let lamports = ctx.accounts.mission_auth.lamports();
        if lamports > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.mission_auth.to_account_info(),
                        to: ctx.accounts.buyer.to_account_info(),
                    },
                    &[seeds],
                ),
                lamports,
            )?;
        }
        let m = &mut ctx.accounts.mission;
        if !m.closed {
            if m.created_at >= ctx.accounts.policy.period_start {
                let unspent = m.budget - m.spent;
                ctx.accounts.policy.period_spent = ctx.accounts.policy.period_spent.saturating_sub(unspent);
            }
            m.closed = true;
        }
        Ok(())
    }
}

/// Who may act on a mission deal: the mission's buyer always (returns true), otherwise only the agent
/// that opened this deal, with a live mandate (returns false).
fn mission_actor(m: &Mission, md: &MissionDeal, actor: Pubkey, mandate: Option<&Mandate>, now: i64) -> Result<bool> {
    if actor == m.buyer {
        return Ok(true);
    }
    let d = mandate.ok_or(DealError::Unauthorized)?;
    require_keys_eq!(d.agent, actor, DealError::Unauthorized);
    require_keys_eq!(md.agent, actor, DealError::NotDealOpener);
    mandate_live(m, d, now)?;
    Ok(false)
}

/// Every check an agent's token movement must pass, then the counters it moves. Order: mission,
/// mandate, stage gate, then each cap from the smallest scope outwards.
fn check_spend(m: &mut Mission, d: &mut Mandate, amount: u64, now: i64) -> Result<()> {
    mandate_live(m, d, now)?;
    require!(amount > 0, DealError::ZeroAmount);
    require!(amount <= d.per_tx_cap, DealError::OverPerTxCap);
    let mandate_spent = d.spent.checked_add(amount).ok_or(DealError::MathOverflow)?;
    require!(mandate_spent <= d.cap, DealError::OverMandateCap);
    let cur = m.current_stage as usize;
    let stage_spent = m.stages[cur].spent.checked_add(amount).ok_or(DealError::MathOverflow)?;
    require!(stage_spent <= m.stages[cur].cap, DealError::OverStageCap);
    let mission_spent = m.spent.checked_add(amount).ok_or(DealError::MathOverflow)?;
    require!(mission_spent <= m.budget, DealError::OverMissionBudget);
    d.spent = mandate_spent;
    m.stages[cur].spent = stage_spent;
    m.spent = mission_spent;
    Ok(())
}

/// Mission open, mandate neither revoked nor expired, current stage approved by the human.
fn mandate_live(m: &Mission, d: &Mandate, now: i64) -> Result<()> {
    require!(!m.closed, DealError::MissionClosed);
    require!(now < m.expires_at, DealError::MissionExpired);
    require!(!d.revoked, DealError::MandateRevoked);
    require!(now < d.expires_at, DealError::MandateExpired);
    require!(m.mandates_locked && m.stages[m.current_stage as usize].approved_at != 0, DealError::StageNotApproved);
    require!(d.stage_mask & (1u8 << m.current_stage) != 0, DealError::NotThisStage);
    Ok(())
}

/// Only listed payees; with no list, only the seller of an active, attested listing in this mint
/// (the payee's token-account owner must be that seller; checked by the caller via `payee`).
fn payee_allowed(d: &Mandate, payee: Pubkey, listing: Option<&Listing>, registry: Option<&AssessorRegistry>, mint: Pubkey) -> Result<()> {
    if !d.payees.is_empty() {
        require!(d.payees.contains(&payee), DealError::PayeeNotAllowed);
        return Ok(());
    }
    let l = listing.ok_or(DealError::PayeeNotAllowed)?;
    require!(l.active && l.assessed_at != 0, DealError::PayeeNotAllowed);
    require!(registry.is_some_and(|r| r.assessors.contains(&l.assessor)), DealError::PayeeNotAllowed);
    require_keys_eq!(l.seller, payee, DealError::PayeeNotAllowed);
    require_keys_eq!(l.mint, mint, DealError::PayeeNotAllowed);
    Ok(())
}

/// Running digest over every mandate added to a mission, in order.
fn mandate_digest(prev: &[u8; 32], p: &MandateParams) -> [u8; 32] {
    let mut parts: Vec<&[u8]> = vec![prev, p.agent.as_ref(), &p.role_hash];
    let cap = p.cap.to_le_bytes();
    let per_tx = p.per_tx_cap.to_le_bytes();
    let exp = p.expires_at.to_le_bytes();
    let mask = [p.stage_mask];
    parts.push(&mask);
    parts.push(&cap);
    parts.push(&per_tx);
    parts.push(&exp);
    for payee in &p.payees {
        parts.push(payee.as_ref());
    }
    solana_sha256_hasher::hashv(&parts).to_bytes()
}

fn read_deal(info: &UncheckedAccount) -> Result<Deal> {
    require_keys_eq!(*info.owner, crate::ID, DealError::Unauthorized);
    let data = info.try_borrow_data()?;
    Ok(Deal::try_deserialize(&mut &data[..])?)
}

/// Re-enters one of the payout instructions as the mission's authority.
fn invoke_settle(a: &AgentSettle, data: Vec<u8>) -> Result<()> {
    let deal = read_deal(&a.deal)?;
    require_keys_eq!(deal.buyer, a.mission_auth.key(), DealError::Unauthorized);
    let metas = crate::accounts::Settle {
        actor: a.mission_auth.key(),
        deal: a.deal.key(),
        policy: a.auth_policy.key(),
        mint: a.mint.key(),
        vault: a.deal_vault.key(),
        buyer_token: a.vault.key(),
        seller_token: a.seller_token.key(),
        seller_rep: a.seller_rep.key(),
        rep_pair: a.rep_pair.key(),
        link: a.link.key(),
        listing: a.listing.as_ref().map(|l| l.key()),
        token_program: a.token_program.key(),
        system_program: a.system_program.key(),
    }
    .to_account_metas(None);
    let mut infos = vec![
        a.mission_auth.to_account_info(), a.deal.to_account_info(), a.auth_policy.to_account_info(), a.mint.to_account_info(),
        a.deal_vault.to_account_info(), a.vault.to_account_info(), a.seller_token.to_account_info(), a.seller_rep.to_account_info(),
        a.rep_pair.to_account_info(), a.link.to_account_info(), a.token_program.to_account_info(), a.system_program.to_account_info(),
        a.deal_program.to_account_info(),
    ];
    if let Some(l) = &a.listing { infos.push(l.to_account_info()); }
    let ix = Instruction { program_id: crate::ID, accounts: metas, data };
    let mission_key = a.mission.key();
    invoke_signed(&ix, &infos, &[&[MISSION_AUTH_SEED, mission_key.as_ref(), &[a.mission.auth_bump]]])?;
    Ok(())
}

/// Everything the vault holds for this deal.
fn total_held(d: &Deal) -> Result<u64> {
    d.amount
        .checked_add(d.stake_posted)
        .and_then(|x| x.checked_add(d.bond_posted))
        .ok_or_else(|| error!(DealError::MathOverflow))
}

/// Seller-wins split: seller gets min(invoice, amount) + stake (+ the buyer's bond if a challenge
/// failed); the buyer gets the unbilled remainder of the order (+ its bond back otherwise).
fn pass_split(d: &Deal, bond_to_seller: bool) -> Result<(u64, u64)> {
    let payout = d.invoice_amount.min(d.amount);
    let mut to_seller = payout.checked_add(d.stake_posted).ok_or(DealError::MathOverflow)?;
    let mut to_buyer = d.amount - payout;
    if bond_to_seller {
        to_seller = to_seller.checked_add(d.bond_posted).ok_or(DealError::MathOverflow)?;
    } else {
        to_buyer = to_buyer.checked_add(d.bond_posted).ok_or(DealError::MathOverflow)?;
    }
    Ok((to_seller, to_buyer))
}

/// |invoice - order| <= order * tolerance; a zero invoice never matches.
pub fn invoice_matches(order: u64, invoice: u64, tolerance_bps: u16) -> bool {
    if invoice == 0 {
        return false;
    }
    let diff = (order as u128).abs_diff(invoice as u128);
    diff * BPS <= (order as u128) * (tolerance_bps as u128)
}

fn bps_of(amount: u64, bps: u16) -> Result<u64> {
    u64::try_from((amount as u128) * (bps as u128) / BPS).map_err(|_| error!(DealError::MathOverflow))
}

fn move_in<'info>(
    from: &InterfaceAccount<'info, TokenAccount>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &Signer<'info>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: vault.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

/// The only place tokens leave the vault. The two payouts must add up to exactly what the vault
/// holds for this deal; refunds credit the buyer's budget for the period the deal was charged to.
fn settle(a: &mut Settle, bumps: &SettleBumps, to_seller: u64, to_buyer: u64, status: DealStatus, credit_budget: bool) -> Result<()> {
    let held = total_held(&a.deal)?;
    require!(
        to_seller.checked_add(to_buyer).ok_or(DealError::MathOverflow)? == held,
        DealError::Conservation
    );
    require!(a.vault.amount >= held, DealError::Conservation);
    let id = a.deal.deal_id.to_le_bytes();
    let bump = [a.deal.bump];
    let buyer = a.deal.buyer;
    let seeds: &[&[u8]] = &[DEAL_SEED, buyer.as_ref(), &id, &bump];
    for (to, amount) in [(&a.seller_token, to_seller), (&a.buyer_token, to_buyer)] {
        if amount == 0 {
            continue;
        }
        transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: a.deal.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            a.mint.decimals,
        )?;
    }
    if credit_budget && a.deal.created_at >= a.policy.period_start {
        a.policy.period_spent = a.policy.period_spent.saturating_sub(a.deal.amount);
    }
    // Deals opened under v2 have no reputation accounts yet; `init_if_needed` made them above.
    init_rep(&mut a.seller_rep, &mut a.rep_pair, a.deal.seller, a.deal.buyer, a.deal.mint, bumps.seller_rep, bumps.rep_pair);
    record_outcome(&mut a.seller_rep, &mut a.rep_pair, &a.deal, status)?;
    // Sales are a statistic: they never block a payout. A listing closed while its deals were
    // open is simply not counted; a wrong listing account is refused.
    if let (Some(link), Some(listing)) = (read_link(&a.link)?, a.listing.as_mut()) {
        require_keys_eq!(listing.key(), link.listing, DealError::ListingMismatch);
        if listing.created_at == link.listing_created_at && matches!(status, DealStatus::Released | DealStatus::Claimed | DealStatus::VerifiedPass) {
            listing.sales = listing.sales.checked_add(1).ok_or(DealError::MathOverflow)?;
        }
    }
    a.deal.status = status;
    emit!(DealEvent { deal: a.deal.key(), status });
    Ok(())
}

/// The deal's DealLink, if the deal was opened from a listing. The account is always passed at
/// its PDA (seeds checked by the caller's constraint), so a party cannot hide it; an empty
/// account means the deal has no listing.
fn read_link(info: &UncheckedAccount) -> Result<Option<DealLink>> {
    if info.data_is_empty() {
        return Ok(None);
    }
    require_keys_eq!(*info.owner, crate::ID, DealError::ListingMismatch);
    let data = info.try_borrow_data()?;
    Ok(Some(DealLink::try_deserialize(&mut &data[..])?))
}

/// Fills in a reputation account pair the first time it is seen (all-zero = just created).
fn init_rep(rep: &mut SellerRep, pair: &mut RepPair, seller: Pubkey, buyer: Pubkey, mint: Pubkey, rep_bump: u8, pair_bump: u8) {
    if rep.seller == Pubkey::default() {
        rep.seller = seller;
        rep.mint = mint;
        rep.bump = rep_bump;
    }
    if pair.seller == Pubkey::default() {
        pair.seller = seller;
        pair.buyer = buyer;
        pair.mint = mint;
        pair.bump = pair_bump;
    }
}

/// How a settled deal counts for the seller. Completed adds the amount actually paid for the
/// work (never the stake or the bond); a failed delivery or a missed deadline after accepting
/// counts against; a withdrawn offer, a missing verdict or an offer never accepted is neutral.
fn record_outcome(rep: &mut SellerRep, pair: &mut RepPair, d: &Deal, status: DealStatus) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    match status {
        DealStatus::Released | DealStatus::Claimed | DealStatus::VerifiedPass => {
            let paid = d.invoice_amount.min(d.amount);
            if pair.completed == 0 {
                rep.distinct_buyers = rep.distinct_buyers.checked_add(1).ok_or(DealError::MathOverflow)?;
            }
            rep.completed = rep.completed.checked_add(1).ok_or(DealError::MathOverflow)?;
            rep.volume = rep.volume.checked_add(paid).ok_or(DealError::MathOverflow)?;
            pair.completed = pair.completed.checked_add(1).ok_or(DealError::MathOverflow)?;
            pair.volume = pair.volume.checked_add(paid).ok_or(DealError::MathOverflow)?;
            rep.max_pair_volume = rep.max_pair_volume.max(pair.volume);
        }
        DealStatus::VerifiedFail => {
            rep.failed = rep.failed.checked_add(1).ok_or(DealError::MathOverflow)?;
            pair.failed = pair.failed.checked_add(1).ok_or(DealError::MathOverflow)?;
        }
        DealStatus::Refunded if d.accepted_at != 0 => {
            rep.failed = rep.failed.checked_add(1).ok_or(DealError::MathOverflow)?;
            pair.failed = pair.failed.checked_add(1).ok_or(DealError::MathOverflow)?;
        }
        _ => {
            rep.neutral = rep.neutral.checked_add(1).ok_or(DealError::MathOverflow)?;
        }
    }
    rep.last_settled_at = now;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PolicyParams {
    pub period_secs: i64,
    pub period_budget: u64,
    pub max_price: u64,
    pub approval_threshold: u64,
    pub approver: Pubkey,
    pub allow_any_seller: bool,
    pub allowed_sellers: Vec<Pubkey>,
}

impl PolicyParams {
    fn validate(&self) -> Result<()> {
        require!((60..=366 * 86_400).contains(&self.period_secs), DealError::BadPolicy);
        require!(self.max_price <= self.period_budget, DealError::BadPolicy);
        require!(self.allowed_sellers.len() <= MAX_ALLOWED_SELLERS, DealError::BadPolicy);
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DealParams {
    pub amount: u64,
    pub deadline: i64,
    pub review_secs: i64,
    pub resolve_secs: i64,
    pub tolerance_bps: u16,
    pub stake_required: u64,
    pub bond_bps: u16,
    pub verifier: Pubkey,
    pub terms_hash: [u8; 32],
    /// When opening from a listing: the listing content hash the buyer saw (ignored otherwise).
    pub listing_content_hash: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct BuyerPolicy {
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub period_secs: i64,
    pub period_start: i64,
    pub period_budget: u64,
    pub period_spent: u64,
    pub max_price: u64,
    pub approval_threshold: u64,
    /// Default pubkey = nobody may approve, so amounts above the threshold are refused.
    pub approver: Pubkey,
    pub allow_any_seller: bool,
    #[max_len(8)]
    pub allowed_sellers: Vec<Pubkey>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Deal {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub mint: Pubkey,
    /// Default pubkey = no verifier; challenges are then impossible.
    pub verifier: Pubkey,
    pub deal_id: u64,
    /// The order (PO) amount the buyer escrowed.
    pub amount: u64,
    pub invoice_amount: u64,
    pub tolerance_bps: u16,
    pub stake_required: u64,
    pub stake_posted: u64,
    pub bond_bps: u16,
    pub bond_posted: u64,
    pub deadline: i64,
    pub review_secs: i64,
    pub resolve_secs: i64,
    /// sha256 of the canonical terms the buyer approved (core `termsHash`).
    pub terms_hash: [u8; 32],
    pub delivery_hash: [u8; 32],
    pub created_at: i64,
    pub accepted_at: i64,
    pub delivered_at: i64,
    pub challenged_at: i64,
    pub status: DealStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ListingKind {
    /// Stored data sold as is; the delivery must equal the listed content hash.
    Data,
    /// An endpoint the seller runs; the method stays with the seller.
    Service,
    /// An agent-team blueprint, hired for a goal.
    Team,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ListingParams {
    pub kind: ListingKind,
    pub price: u64,
    pub content_hash: [u8; 32],
    pub meta_hash: [u8; 32],
    pub terms_template_hash: [u8; 32],
    pub assessor: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ListingUpdate {
    pub price: Option<u64>,
    pub active: Option<bool>,
    pub content_hash: Option<[u8; 32]>,
    pub meta_hash: Option<[u8; 32]>,
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub seller: Pubkey,
    pub listing_id: u64,
    pub kind: ListingKind,
    pub mint: Pubkey,
    pub price: u64,
    /// sha256 of the data (Data), of the endpoint descriptor (Service) or of the blueprint (Team).
    pub content_hash: [u8; 32],
    /// sha256 of the canonical metadata JSON (name, description, category, tags, URI) kept off chain.
    pub meta_hash: [u8; 32],
    pub terms_template_hash: [u8; 32],
    pub assessor: Pubkey,
    /// Zero until the assessor attests; cleared whenever the content or metadata changes.
    pub report_hash: [u8; 32],
    pub assessed_at: i64,
    pub active: bool,
    pub sales: u64,
    pub created_at: i64,
    pub bump: u8,
}

/// Assessors whose attestations count, kept by the program's upgrade authority.
#[account]
#[derive(InitSpace)]
pub struct AssessorRegistry {
    pub authority: Pubkey,
    #[max_len(16)]
    pub assessors: Vec<Pubkey>,
    pub bump: u8,
}

/// Binds a deal to the listing it was opened from (Deal itself is unchanged since v2).
#[account]
#[derive(InitSpace)]
pub struct DealLink {
    pub deal: Pubkey,
    pub listing: Pubkey,
    /// For Data listings, the content hash the delivery must equal; zero = no check.
    pub expected_delivery_hash: [u8; 32],
    /// Which incarnation of the listing PDA (a closed and recreated listing has a new created_at).
    pub listing_created_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MissionParams {
    pub budget: u64,
    /// Hash of the canonical mission terms (core `missionTerms`), recorded for audit.
    pub terms_hash: [u8; 32],
    /// The team listing hired (default = none).
    pub team_listing: Pubkey,
    /// One cap per stage, in order (1..=8).
    pub stage_caps: Vec<u64>,
    pub expires_at: i64,
    /// SOL moved to the mission authority to pay rent for the deals agents open.
    pub rent_lamports: u64,
    /// Every deal an agent opens must name this verifier (not the buyer).
    pub verifier: Pubkey,
    /// Agents' deals give the buyer at least this long to review a delivery, and the verifier this long to rule.
    pub min_review_secs: i64,
    pub min_resolve_secs: i64,
    /// Agents' deals accept invoices at most this far from the order.
    pub max_tolerance_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MandateParams {
    pub agent: Pubkey,
    pub role_hash: [u8; 32],
    pub cap: u64,
    pub per_tx_cap: u64,
    /// Token-account owners this agent may pay; empty = only sellers of attested listings.
    pub payees: Vec<Pubkey>,
    /// Bit i set = this agent may spend in stage i (the blueprint's stages[].roles).
    pub stage_mask: u8,
    pub expires_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Stage {
    pub cap: u64,
    pub spent: u64,
    /// The plan the human approved for this stage; zero until approved.
    pub plan_hash: [u8; 32],
    pub approved_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Mission {
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub mission_id: u64,
    pub team_listing: Pubkey,
    pub terms_hash: [u8; 32],
    pub budget: u64,
    /// Everything that ever left the mission vault through an agent (spends, deals, bonds).
    /// Refunds coming back never reduce it: caps limit outflow.
    pub spent: u64,
    pub mandate_caps: u64,
    pub mandate_count: u32,
    pub mandates_digest: [u8; 32],
    pub mandates_locked: bool,
    #[max_len(8)]
    pub stages: Vec<Stage>,
    pub current_stage: u8,
    pub expires_at: i64,
    pub created_at: i64,
    pub closed: bool,
    pub verifier: Pubkey,
    pub min_review_secs: i64,
    pub min_resolve_secs: i64,
    pub max_tolerance_bps: u16,
    pub auth_bump: u8,
    pub bump: u8,
}

/// Which agent opened a mission deal (only it, or the buyer, may release or challenge it).
#[account]
#[derive(InitSpace)]
pub struct MissionDeal {
    pub mission: Pubkey,
    pub deal: Pubkey,
    pub agent: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub mission: Pubkey,
    /// The agent's own key (its wallet, holding SOL for fees only).
    pub agent: Pubkey,
    pub role_hash: [u8; 32],
    pub cap: u64,
    pub per_tx_cap: u64,
    pub spent: u64,
    #[max_len(8)]
    pub payees: Vec<Pubkey>,
    pub stage_mask: u8,
    pub expires_at: i64,
    pub revoked: bool,
    pub bump: u8,
}

#[event]
pub struct SpendEvent {
    pub mission: Pubkey,
    pub agent: Pubkey,
    pub payee: Pubkey,
    pub amount: u64,
    pub receipt_hash: [u8; 32],
}

/// A seller's track record in one token, written only by `settle`.
#[account]
#[derive(InitSpace)]
pub struct SellerRep {
    pub seller: Pubkey,
    /// Amounts are only comparable within one mint; scoring reads the USDC record.
    pub mint: Pubkey,
    pub completed: u64,
    pub failed: u64,
    pub neutral: u64,
    /// Sum of amounts paid for completed work (min(invoice, order)), excluding stakes and bonds.
    pub volume: u64,
    /// Buyers with at least one completed deal with this seller.
    pub distinct_buyers: u64,
    /// The largest completed volume with any single buyer (concentration check).
    pub max_pair_volume: u64,
    pub last_settled_at: i64,
    pub bump: u8,
}

/// The history between one seller and one buyer.
#[account]
#[derive(InitSpace)]
pub struct RepPair {
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub completed: u64,
    pub failed: u64,
    pub volume: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum DealStatus {
    Open,
    Funded,
    Delivered,
    Challenged,
    Released,
    Claimed,
    Refunded,
    Cancelled,
    VerifiedPass,
    VerifiedFail,
    NoVerdict,
}

#[event]
pub struct DealEvent {
    pub deal: Pubkey,
    pub status: DealStatus,
}

#[derive(Accounts)]
pub struct InitPolicy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = buyer, space = 8 + BuyerPolicy::INIT_SPACE, seeds = [POLICY_SEED, buyer.key().as_ref()], bump)]
    pub policy: Box<Account<'info, BuyerPolicy>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer @ DealError::Unauthorized, seeds = [POLICY_SEED, buyer.key().as_ref()], bump = policy.bump)]
    pub policy: Account<'info, BuyerPolicy>,
}

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct CreateDeal<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: any address may be a seller (subject to the buyer's policy); it only ever receives
    /// tokens into its own token account.
    pub seller: UncheckedAccount<'info>,
    /// Required only when the amount is above the policy's approval threshold.
    pub approver: Option<Signer<'info>>,
    #[account(mut, has_one = buyer @ DealError::Unauthorized, seeds = [POLICY_SEED, buyer.key().as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, BuyerPolicy>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Deal::INIT_SPACE,
        seeds = [DEAL_SEED, buyer.key().as_ref(), &deal_id.to_le_bytes()],
        bump,
    )]
    pub deal: Box<Account<'info, Deal>>,
    #[account(init_if_needed, payer = buyer, space = 8 + SellerRep::INIT_SPACE, seeds = [REP_SEED, seller.key().as_ref(), mint.key().as_ref()], bump)]
    pub seller_rep: Box<Account<'info, SellerRep>>,
    #[account(init_if_needed, payer = buyer, space = 8 + RepPair::INIT_SPACE, seeds = [REP_SEED, seller.key().as_ref(), buyer.key().as_ref(), mint.key().as_ref()], bump)]
    pub rep_pair: Box<Account<'info, RepPair>>,
    /// Present only when the deal is opened from a listing.
    pub listing: Option<Box<Account<'info, Listing>>>,
    #[account(init, payer = buyer, space = 8 + DealLink::INIT_SPACE, seeds = [LINK_SEED, deal.key().as_ref()], bump)]
    pub link: Option<Box<Account<'info, DealLink>>>,
    /// Required with a listing: its assessor must still be registered.
    #[account(seeds = [ASSESSORS_SEED], bump = registry.bump)]
    pub registry: Option<Box<Account<'info, AssessorRegistry>>>,
    #[account(
        init,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = deal,
        associated_token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Accept<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller @ DealError::Unauthorized, has_one = mint)]
    pub deal: Box<Account<'info, Deal>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = deal, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = seller, token::token_program = token_program)]
    pub seller_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SubmitDelivery<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller @ DealError::Unauthorized)]
    pub deal: Account<'info, Deal>,
    /// CHECK: the deal's DealLink PDA, always passed; empty when the deal has no listing (read_link).
    #[account(seeds = [LINK_SEED, deal.key().as_ref()], bump)]
    pub link: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Challenge<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer @ DealError::Unauthorized, has_one = mint)]
    pub deal: Box<Account<'info, Deal>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = deal, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(listing_id: u64)]
pub struct CreateListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = seller, space = 8 + Listing::INIT_SPACE, seeds = [LISTING_SEED, seller.key().as_ref(), &listing_id.to_le_bytes()], bump)]
    pub listing: Box<Account<'info, Listing>>,
    #[account(seeds = [ASSESSORS_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, AssessorRegistry>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAssessors<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: this program's ProgramData (address and owner checked here, the upgrade authority
    /// read from its header in `set_assessors`): proves `authority` is the upgrade authority.
    #[account(address = bpf_loader_upgradeable::get_program_data_address(&crate::ID), owner = bpf_loader_upgradeable::ID)]
    pub program_data: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = authority, space = 8 + AssessorRegistry::INIT_SPACE, seeds = [ASSESSORS_SEED], bump)]
    pub registry: Box<Account<'info, AssessorRegistry>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AttestListing<'info> {
    pub assessor: Signer<'info>,
    #[account(mut)]
    pub listing: Box<Account<'info, Listing>>,
    #[account(seeds = [ASSESSORS_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, AssessorRegistry>>,
}

#[derive(Accounts)]
pub struct UpdateListing<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller @ DealError::Unauthorized)]
    pub listing: Box<Account<'info, Listing>>,
}

#[derive(Accounts)]
pub struct CloseListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller @ DealError::Unauthorized, close = seller)]
    pub listing: Box<Account<'info, Listing>>,
}

#[derive(Accounts)]
#[instruction(mission_id: u64)]
pub struct CreateMission<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// Required only when the budget is above the policy's approval threshold.
    pub approver: Option<Signer<'info>>,
    #[account(mut, has_one = buyer @ DealError::Unauthorized, seeds = [POLICY_SEED, buyer.key().as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, BuyerPolicy>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = buyer, space = 8 + Mission::INIT_SPACE, seeds = [MISSION_SEED, buyer.key().as_ref(), &mission_id.to_le_bytes()], bump)]
    pub mission: Box<Account<'info, Mission>>,
    /// The mission's authority: owns the vault, is the buyer of record of agents' deals.
    #[account(mut, seeds = [MISSION_AUTH_SEED, mission.key().as_ref()], bump)]
    pub mission_auth: SystemAccount<'info>,
    #[account(init, payer = buyer, space = 8 + BuyerPolicy::INIT_SPACE, seeds = [POLICY_SEED, mission_auth.key().as_ref()], bump)]
    pub auth_policy: Box<Account<'info, BuyerPolicy>>,
    #[account(init, payer = buyer, associated_token::mint = mint, associated_token::authority = mission_auth, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(p: MandateParams)]
pub struct AddMandate<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer @ DealError::Unauthorized)]
    pub mission: Box<Account<'info, Mission>>,
    #[account(init, payer = buyer, space = 8 + Mandate::INIT_SPACE, seeds = [MANDATE_SEED, mission.key().as_ref(), p.agent.as_ref()], bump)]
    pub mandate: Box<Account<'info, Mandate>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveStage<'info> {
    pub buyer: Signer<'info>,
    pub approver: Option<Signer<'info>>,
    #[account(seeds = [POLICY_SEED, buyer.key().as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, BuyerPolicy>>,
    #[account(mut, has_one = buyer @ DealError::Unauthorized)]
    pub mission: Box<Account<'info, Mission>>,
}

#[derive(Accounts)]
pub struct AgentSpend<'info> {
    pub agent: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub mission: Box<Account<'info, Mission>>,
    #[account(mut, has_one = agent @ DealError::Unauthorized, has_one = mission @ DealError::Unauthorized, seeds = [MANDATE_SEED, mission.key().as_ref(), agent.key().as_ref()], bump = mandate.bump)]
    pub mandate: Box<Account<'info, Mandate>>,
    /// CHECK: PDA signer for the vault; seeds checked.
    #[account(seeds = [MISSION_AUTH_SEED, mission.key().as_ref()], bump = mission.auth_bump)]
    pub mission_auth: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = mission_auth, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub payee_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Required when the mandate has no payee list: the payee must be this listing's seller.
    pub listing: Option<Box<Account<'info, Listing>>>,
    /// Required with a listing: its assessor must be registered.
    #[account(seeds = [ASSESSORS_SEED], bump = registry.bump)]
    pub registry: Option<Box<Account<'info, AssessorRegistry>>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AgentOpenDeal<'info> {
    pub agent: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub mission: Box<Account<'info, Mission>>,
    #[account(mut, has_one = agent @ DealError::Unauthorized, has_one = mission @ DealError::Unauthorized, seeds = [MANDATE_SEED, mission.key().as_ref(), agent.key().as_ref()], bump = mandate.bump)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, seeds = [MISSION_AUTH_SEED, mission.key().as_ref()], bump = mission.auth_bump)]
    pub mission_auth: SystemAccount<'info>,
    /// CHECK: checked by create_deal (and here against the mandate's payees or the listing).
    pub seller: UncheckedAccount<'info>,
    /// CHECK: the authority's policy; checked by create_deal.
    #[account(mut)]
    pub auth_policy: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = mission_auth, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: created by create_deal.
    #[account(mut)]
    pub deal: UncheckedAccount<'info>,
    /// CHECK: created by create_deal.
    #[account(mut)]
    pub deal_vault: UncheckedAccount<'info>,
    /// CHECK: created here after the deal, at its PDA (records the opening agent).
    #[account(mut, seeds = [MISSION_DEAL_SEED, deal.key().as_ref()], bump)]
    pub mission_deal: UncheckedAccount<'info>,
    /// CHECK: checked by create_deal.
    #[account(mut)]
    pub seller_rep: UncheckedAccount<'info>,
    /// CHECK: checked by create_deal.
    #[account(mut)]
    pub rep_pair: UncheckedAccount<'info>,
    pub listing: Option<Box<Account<'info, Listing>>>,
    /// CHECK: created by create_deal when a listing is given.
    #[account(mut)]
    pub link: Option<UncheckedAccount<'info>>,
    #[account(seeds = [ASSESSORS_SEED], bump = registry.bump)]
    pub registry: Option<Box<Account<'info, AssessorRegistry>>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub deal_program: Program<'info, crate::program::DealEscrow>,
}

#[derive(Accounts)]
pub struct AgentSettle<'info> {
    /// The mission's buyer, or the agent that opened the deal.
    pub agent: Signer<'info>,
    #[account(has_one = mint)]
    pub mission: Box<Account<'info, Mission>>,
    /// The acting agent's mandate (not needed when the buyer acts).
    #[account(has_one = agent @ DealError::Unauthorized, has_one = mission @ DealError::Unauthorized, seeds = [MANDATE_SEED, mission.key().as_ref(), agent.key().as_ref()], bump = mandate.bump)]
    pub mandate: Option<Box<Account<'info, Mandate>>>,
    #[account(seeds = [MISSION_DEAL_SEED, deal.key().as_ref()], bump = mission_deal.bump, has_one = mission @ DealError::Unauthorized)]
    pub mission_deal: Box<Account<'info, MissionDeal>>,
    #[account(mut, seeds = [MISSION_AUTH_SEED, mission.key().as_ref()], bump = mission.auth_bump)]
    pub mission_auth: SystemAccount<'info>,
    /// CHECK: a deal whose buyer is this mission's authority (read_deal + release checks).
    #[account(mut)]
    pub deal: UncheckedAccount<'info>,
    /// CHECK: checked by release.
    #[account(mut)]
    pub auth_policy: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: checked by release.
    #[account(mut)]
    pub deal_vault: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = mission_auth, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: checked by release.
    #[account(mut)]
    pub seller_token: UncheckedAccount<'info>,
    /// CHECK: checked by release.
    #[account(mut)]
    pub seller_rep: UncheckedAccount<'info>,
    /// CHECK: checked by release.
    #[account(mut)]
    pub rep_pair: UncheckedAccount<'info>,
    /// CHECK: checked by release.
    pub link: UncheckedAccount<'info>,
    /// CHECK: checked by release.
    #[account(mut)]
    pub listing: Option<UncheckedAccount<'info>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub deal_program: Program<'info, crate::program::DealEscrow>,
}

#[derive(Accounts)]
pub struct AgentChallenge<'info> {
    /// The mission's buyer, or the agent that opened the deal.
    pub agent: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub mission: Box<Account<'info, Mission>>,
    #[account(mut, has_one = agent @ DealError::Unauthorized, has_one = mission @ DealError::Unauthorized, seeds = [MANDATE_SEED, mission.key().as_ref(), agent.key().as_ref()], bump = mandate.bump)]
    pub mandate: Option<Box<Account<'info, Mandate>>>,
    #[account(seeds = [MISSION_DEAL_SEED, deal.key().as_ref()], bump = mission_deal.bump, has_one = mission @ DealError::Unauthorized)]
    pub mission_deal: Box<Account<'info, MissionDeal>>,
    /// CHECK: PDA signer; seeds checked.
    #[account(seeds = [MISSION_AUTH_SEED, mission.key().as_ref()], bump = mission.auth_bump)]
    pub mission_auth: UncheckedAccount<'info>,
    /// CHECK: a deal whose buyer is this mission's authority (checked in the handler).
    #[account(mut)]
    pub deal: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: checked by challenge.
    #[account(mut)]
    pub deal_vault: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = mission_auth, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub deal_program: Program<'info, crate::program::DealEscrow>,
}

#[derive(Accounts)]
pub struct RevokeMandate<'info> {
    pub buyer: Signer<'info>,
    #[account(has_one = buyer @ DealError::Unauthorized)]
    pub mission: Box<Account<'info, Mission>>,
    #[account(mut, has_one = mission @ DealError::Unauthorized)]
    pub mandate: Box<Account<'info, Mandate>>,
}

#[derive(Accounts)]
pub struct CloseMission<'info> {
    pub actor: Signer<'info>,
    #[account(mut, has_one = mint, has_one = buyer)]
    pub mission: Box<Account<'info, Mission>>,
    /// CHECK: receives the authority's unused SOL; must be the mission's buyer (has_one).
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,
    #[account(mut, seeds = [POLICY_SEED, mission.buyer.as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, BuyerPolicy>>,
    #[account(mut, seeds = [MISSION_AUTH_SEED, mission.key().as_ref()], bump = mission.auth_bump)]
    pub mission_auth: SystemAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = mission_auth, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = mission.buyer, token::token_program = token_program)]
    pub buyer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Shared by every instruction that pays out of the vault. Payouts can only reach the deal's own
/// buyer and seller token accounts, so the caller (`actor`) never chooses where money goes.
#[derive(Accounts)]
pub struct Settle<'info> {
    /// Pays rent only when a v2-era deal settles before its reputation accounts exist.
    #[account(mut)]
    pub actor: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub deal: Box<Account<'info, Deal>>,
    #[account(mut, seeds = [POLICY_SEED, deal.buyer.as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, BuyerPolicy>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = deal, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = deal.buyer, token::token_program = token_program)]
    pub buyer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = deal.seller, token::token_program = token_program)]
    pub seller_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = actor, space = 8 + SellerRep::INIT_SPACE, seeds = [REP_SEED, deal.seller.as_ref(), deal.mint.as_ref()], bump)]
    pub seller_rep: Box<Account<'info, SellerRep>>,
    #[account(init_if_needed, payer = actor, space = 8 + RepPair::INIT_SPACE, seeds = [REP_SEED, deal.seller.as_ref(), deal.buyer.as_ref(), deal.mint.as_ref()], bump)]
    pub rep_pair: Box<Account<'info, RepPair>>,
    /// CHECK: the deal's DealLink PDA, always passed; empty when the deal has no listing (read_link).
    #[account(seeds = [LINK_SEED, deal.key().as_ref()], bump)]
    pub link: UncheckedAccount<'info>,
    /// The deal's listing, if it has one and it still exists (its sales are counted).
    #[account(mut)]
    pub listing: Option<Box<Account<'info, Listing>>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum DealError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deadline must be in the future")]
    DeadlineInPast,
    #[msg("Review window must be between 0 and 30 days")]
    BadReviewWindow,
    #[msg("Buyer and seller must differ")]
    SelfDeal,
    #[msg("Deal is not in the right status for this action")]
    WrongStatus,
    #[msg("Delivery deadline has passed")]
    DeadlinePassed,
    #[msg("Deadline has not passed yet")]
    DeadlineNotReached,
    #[msg("Buyer review window is still open")]
    ReviewWindowOpen,
    #[msg("Signer is not a party to this deal")]
    Unauthorized,
    #[msg("Deadline is more than 30 days away")]
    DeadlineTooFar,
    #[msg("Invoice tolerance must be at most 20%")]
    BadTolerance,
    #[msg("Challenge bond must be at most 50%")]
    BadBond,
    #[msg("Resolve window must be between 60 seconds and 30 days")]
    BadResolveWindow,
    #[msg("The verifier must be neither buyer nor seller")]
    VerifierNotIndependent,
    #[msg("Policy is for a different token")]
    PolicyMintMismatch,
    #[msg("Seller is not on the buyer's allowlist")]
    SellerNotAllowed,
    #[msg("Amount is above the buyer's max price")]
    OverMaxPrice,
    #[msg("Amount would exceed the buyer's budget for this period")]
    OverPeriodBudget,
    #[msg("Amount is above the approval threshold and the approver did not sign")]
    ApprovalRequired,
    #[msg("Delivery hash must not be empty")]
    EmptyDelivery,
    #[msg("Invoice does not match the order amount within tolerance")]
    InvoiceMismatch,
    #[msg("Release names a different delivery than the one submitted")]
    DeliveryMismatch,
    #[msg("This deal has no verifier, so it cannot be challenged")]
    NoVerifier,
    #[msg("Review window has closed")]
    ReviewWindowClosed,
    #[msg("Only the deal's verifier can resolve")]
    NotVerifier,
    #[msg("Resolve window has closed")]
    ResolveWindowClosed,
    #[msg("Resolve window is still open")]
    ResolveWindowOpen,
    #[msg("Payout does not equal what the vault holds for this deal")]
    Conservation,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Invalid policy parameters")]
    BadPolicy,
    #[msg("Invalid listing parameters")]
    BadListing,
    #[msg("The assessor must be set and must not be the seller")]
    AssessorNotIndependent,
    #[msg("Only the listing's assessor can attest it")]
    NotAssessor,
    #[msg("Listing is not active")]
    ListingInactive,
    #[msg("Listing has not been attested by its assessor")]
    ListingNotAttested,
    #[msg("Deal does not match its listing")]
    ListingMismatch,
    #[msg("Delivery is not the listed content")]
    NotListedContent,
    #[msg("Invalid mission parameters")]
    BadMission,
    #[msg("Invalid mandate parameters")]
    BadMandate,
    #[msg("Mission is closed")]
    MissionClosed,
    #[msg("Mission has expired")]
    MissionExpired,
    #[msg("Mandates can no longer change once the first stage is approved")]
    MandatesLocked,
    #[msg("The mandate set is not the one the approval names")]
    MandatesChanged,
    #[msg("Stage cannot be approved now")]
    BadStage,
    #[msg("The current stage has not been approved by the buyer")]
    StageNotApproved,
    #[msg("Mandate has been revoked")]
    MandateRevoked,
    #[msg("Mandate has expired")]
    MandateExpired,
    #[msg("Amount is above the mandate's per-payment cap")]
    OverPerTxCap,
    #[msg("Amount would exceed the mandate's cap")]
    OverMandateCap,
    #[msg("Amount would exceed the stage's cap")]
    OverStageCap,
    #[msg("Amount would exceed the mission budget")]
    OverMissionBudget,
    #[msg("Payee is not allowed by the mandate")]
    PayeeNotAllowed,
    #[msg("This agent does not work in the current stage")]
    NotThisStage,
    #[msg("The assessor is not on the registry of assessors")]
    AssessorNotRegistered,
    #[msg("An agent's deal must use the mission's verifier and at least its review and resolve windows")]
    DealTermsNotAllowed,
    #[msg("Only the agent that opened this deal (or the buyer) may act on it")]
    NotDealOpener,
}
