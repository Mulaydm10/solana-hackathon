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
//! Tokens leave the vault only in `settle`, after every check, and only to the deal's own buyer and
//! seller token accounts; a refused instruction moves nothing.
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV");

pub const DEAL_SEED: &[u8] = b"deal";
pub const POLICY_SEED: &[u8] = b"policy";
pub const REP_SEED: &[u8] = b"rep";
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
    a.deal.status = status;
    emit!(DealEvent { deal: a.deal.key(), status });
    Ok(())
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
}
