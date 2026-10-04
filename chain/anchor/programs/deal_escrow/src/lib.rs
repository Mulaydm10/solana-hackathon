//! deal_escrow: pay-on-delivery escrow, the first deal template of the procurement layer.
//!
//! The buyer locks tokens in a vault owned by the deal PDA. The seller is paid only after
//! delivering (buyer releases, or the buyer's review window lapses). With no delivery by the
//! deadline, anyone can trigger a refund to the buyer. Every rule is enforced here, not by a server.
//! See `contracts/chain.md`.
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV");

pub const DEAL_SEED: &[u8] = b"deal";
/// Longest review window the program accepts (30 days).
pub const MAX_REVIEW_SECS: i64 = 30 * 86_400;

#[program]
pub mod deal_escrow {
    use super::*;

    /// Buyer opens a deal and moves `amount` into the vault in the same instruction.
    pub fn create_deal(
        ctx: Context<CreateDeal>,
        deal_id: u64,
        amount: u64,
        deadline: i64,
        review_secs: i64,
        terms_hash: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(amount > 0, DealError::ZeroAmount);
        require!(deadline > now, DealError::DeadlineInPast);
        require!((0..=MAX_REVIEW_SECS).contains(&review_secs), DealError::BadReviewWindow);
        require_keys_neq!(ctx.accounts.buyer.key(), ctx.accounts.seller.key(), DealError::SelfDeal);

        ctx.accounts.deal.set_inner(Deal {
            buyer: ctx.accounts.buyer.key(),
            seller: ctx.accounts.seller.key(),
            mint: ctx.accounts.mint.key(),
            deal_id,
            amount,
            deadline,
            review_secs,
            terms_hash,
            delivery_hash: [0; 32],
            created_at: now,
            delivered_at: 0,
            status: DealStatus::Funded,
            bump: ctx.bumps.deal,
        });

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(DealEvent { deal: ctx.accounts.deal.key(), status: DealStatus::Funded });
        Ok(())
    }

    /// Seller records a hash of what was delivered. Only while funded and before the deadline.
    pub fn submit_delivery(ctx: Context<SubmitDelivery>, delivery_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deal = &mut ctx.accounts.deal;
        require!(deal.status == DealStatus::Funded, DealError::WrongStatus);
        require!(now <= deal.deadline, DealError::DeadlinePassed);
        deal.delivery_hash = delivery_hash;
        deal.delivered_at = now;
        deal.status = DealStatus::Delivered;
        emit!(DealEvent { deal: deal.key(), status: DealStatus::Delivered });
        Ok(())
    }

    /// Buyer accepts the delivery; the vault pays the seller.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        require!(ctx.accounts.deal.status == DealStatus::Delivered, DealError::WrongStatus);
        pay_out(&ctx.accounts.deal, &ctx.accounts.vault, &ctx.accounts.seller_token, &ctx.accounts.mint, &ctx.accounts.token_program)?;
        ctx.accounts.deal.status = DealStatus::Released;
        emit!(DealEvent { deal: ctx.accounts.deal.key(), status: DealStatus::Released });
        Ok(())
    }

    /// Anyone may refund the buyer once the deadline has passed without a delivery.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(ctx.accounts.deal.status == DealStatus::Funded, DealError::WrongStatus);
        require!(now > ctx.accounts.deal.deadline, DealError::DeadlineNotReached);
        pay_out(&ctx.accounts.deal, &ctx.accounts.vault, &ctx.accounts.buyer_token, &ctx.accounts.mint, &ctx.accounts.token_program)?;
        ctx.accounts.deal.status = DealStatus::Refunded;
        emit!(DealEvent { deal: ctx.accounts.deal.key(), status: DealStatus::Refunded });
        Ok(())
    }

    /// Seller collects after delivering if the buyer stayed silent for the whole review window.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deal = &ctx.accounts.deal;
        require!(deal.status == DealStatus::Delivered, DealError::WrongStatus);
        require!(now >= deal.delivered_at.saturating_add(deal.review_secs), DealError::ReviewWindowOpen);
        pay_out(&ctx.accounts.deal, &ctx.accounts.vault, &ctx.accounts.seller_token, &ctx.accounts.mint, &ctx.accounts.token_program)?;
        ctx.accounts.deal.status = DealStatus::Claimed;
        emit!(DealEvent { deal: ctx.accounts.deal.key(), status: DealStatus::Claimed });
        Ok(())
    }
}

/// Move the whole escrowed amount out of the vault, signed by the deal PDA.
fn pay_out<'info>(
    deal: &Account<'info, Deal>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let id = deal.deal_id.to_le_bytes();
    let seeds: &[&[u8]] = &[DEAL_SEED, deal.buyer.as_ref(), &id, &[deal.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: deal.to_account_info(),
            },
            &[seeds],
        ),
        deal.amount,
        mint.decimals,
    )
}

#[account]
#[derive(InitSpace)]
pub struct Deal {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub deal_id: u64,
    pub amount: u64,
    pub deadline: i64,
    pub review_secs: i64,
    /// sha256 of the canonical terms the buyer approved (core `termsHash`).
    pub terms_hash: [u8; 32],
    pub delivery_hash: [u8; 32],
    pub created_at: i64,
    pub delivered_at: i64,
    pub status: DealStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum DealStatus {
    Funded,
    Delivered,
    Released,
    Refunded,
    Claimed,
}

#[event]
pub struct DealEvent {
    pub deal: Pubkey,
    pub status: DealStatus,
}

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct CreateDeal<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: any address may be a seller; it only ever receives tokens into its own token account.
    pub seller: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Deal::INIT_SPACE,
        seeds = [DEAL_SEED, buyer.key().as_ref(), &deal_id.to_le_bytes()],
        bump,
    )]
    pub deal: Account<'info, Deal>,
    #[account(
        init,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = deal,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitDelivery<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller @ DealError::Unauthorized)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer @ DealError::Unauthorized, has_one = mint)]
    pub deal: Account<'info, Deal>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = deal, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = deal.seller, token::token_program = token_program)]
    pub seller_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, has_one = mint)]
    pub deal: Account<'info, Deal>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = deal, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = deal.buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller @ DealError::Unauthorized, has_one = mint)]
    pub deal: Account<'info, Deal>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = deal, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = seller, token::token_program = token_program)]
    pub seller_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
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
}
