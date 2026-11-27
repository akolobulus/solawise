use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h");

pub const MAX_MEMBERS: usize = 12;

#[program]
pub mod solawise {
    use super::*;

    pub fn create_goal(
        ctx: Context<CreateGoal>,
        goal_id: u64,
        name: String,
        target: u64,
        maturity_ts: i64,
    ) -> Result<()> {
        require!(name.len() <= 32, SolaError::NameTooLong);
        require!(target > 0, SolaError::InvalidAmount);
        require!(
            maturity_ts > Clock::get()?.unix_timestamp,
            SolaError::MaturityInPast
        );

        let goal = &mut ctx.accounts.goal;
        goal.owner = ctx.accounts.owner.key();
        goal.mint = ctx.accounts.mint.key();
        goal.goal_id = goal_id;
        goal.name = name;
        goal.target = target;
        goal.saved = 0;
        goal.maturity_ts = maturity_ts;
        goal.bump = ctx.bumps.goal;
        Ok(())
    }

    pub fn deposit_goal(ctx: Context<DepositGoal>, amount: u64) -> Result<()> {
        require!(amount > 0, SolaError::InvalidAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.owner_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        ctx.accounts.goal.saved = ctx
            .accounts
            .goal
            .saved
            .checked_add(amount)
            .ok_or(SolaError::MathOverflow)?;
        Ok(())
    }

    pub fn withdraw_goal(ctx: Context<WithdrawGoal>) -> Result<()> {
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.goal.maturity_ts,
            SolaError::StillLocked
        );

        let amount = ctx.accounts.vault.amount;
        if amount > 0 {
            let owner = ctx.accounts.goal.owner;
            let goal_id = ctx.accounts.goal.goal_id.to_le_bytes();
            let bump = [ctx.accounts.goal.bump];
            let seeds: &[&[u8]] = &[b"goal", owner.as_ref(), &goal_id, &bump];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.owner_ata.to_account_info(),
                        authority: ctx.accounts.goal.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
            )?;
        }

        let owner = ctx.accounts.goal.owner;
        let goal_id = ctx.accounts.goal.goal_id.to_le_bytes();
        let bump = [ctx.accounts.goal.bump];
        let seeds: &[&[u8]] = &[b"goal", owner.as_ref(), &goal_id, &bump];
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.goal.to_account_info(),
            },
            &[seeds],
        ))?;
        Ok(())
    }

    pub fn create_circle(
        ctx: Context<CreateCircle>,
        circle_id: u64,
        max_members: u8,
        contribution: u64,
        collateral: u64,
        cycle_secs: i64,
    ) -> Result<()> {
        require!(
            max_members >= 2 && max_members as usize <= MAX_MEMBERS,
            SolaError::InvalidMembers
        );
        require!(contribution > 0 && cycle_secs > 0, SolaError::InvalidAmount);

        let circle = &mut ctx.accounts.circle;
        circle.creator = ctx.accounts.creator.key();
        circle.mint = ctx.accounts.mint.key();
        circle.circle_id = circle_id;
        circle.max_members = max_members;
        circle.joined = 0;
        circle.contribution = contribution;
        circle.collateral = collateral;
        circle.cycle_secs = cycle_secs;
        circle.status = CircleStatus::Open;
        circle.round = 0;
        circle.round_start = 0;
        circle.members = [Member::default(); MAX_MEMBERS];
        circle.bump = ctx.bumps.circle;
        Ok(())
    }

    pub fn join_circle(ctx: Context<MemberAction>) -> Result<()> {
        let key = ctx.accounts.member.key();
        let (collateral, index) = {
            let circle = &ctx.accounts.circle;
            require!(circle.status == CircleStatus::Open, SolaError::NotOpen);
            require!(
                !circle
                    .members
                    .iter()
                    .take(circle.joined as usize)
                    .any(|member| member.key == key),
                SolaError::AlreadyMember
            );
            (circle.collateral, circle.joined as usize)
        };
        require!(index < MAX_MEMBERS, SolaError::InvalidMembers);

        if collateral > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.member_ata.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.member.to_account_info(),
                    },
                ),
                collateral,
            )?;
        }

        let circle = &mut ctx.accounts.circle;
        circle.members[index] = Member {
            key,
            collateral,
            paid: false,
            received: false,
            defaulted: false,
        };
        circle.joined += 1;
        if circle.joined == circle.max_members {
            circle.status = CircleStatus::Active;
            circle.round = 0;
            circle.round_start = Clock::get()?.unix_timestamp;
        }
        Ok(())
    }

    pub fn contribute(ctx: Context<MemberAction>) -> Result<()> {
        let key = ctx.accounts.member.key();
        let now = Clock::get()?.unix_timestamp;
        let (index, amount) = {
            let circle = &ctx.accounts.circle;
            require!(circle.status == CircleStatus::Active, SolaError::NotActive);
            let deadline = circle
                .round_start
                .checked_add(circle.cycle_secs)
                .ok_or(SolaError::MathOverflow)?;
            require!(now < deadline, SolaError::RoundClosed);
            let index = member_index(circle, &key)?;
            require!(!circle.members[index].paid, SolaError::AlreadyPaid);
            (index, circle.contribution)
        };

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.member_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.member.to_account_info(),
                },
            ),
            amount,
        )?;
        ctx.accounts.circle.members[index].paid = true;
        Ok(())
    }

    pub fn settle_round(ctx: Context<SettleRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (pot, creator, circle_id, bump) = {
            let circle = &mut ctx.accounts.circle;
            require!(circle.status == CircleStatus::Active, SolaError::NotActive);
            let deadline = circle
                .round_start
                .checked_add(circle.cycle_secs)
                .ok_or(SolaError::MathOverflow)?;
            require!(now >= deadline, SolaError::RoundNotOver);
            let recipient_index = circle.round as usize;
            require!(
                recipient_index < circle.max_members as usize,
                SolaError::InvalidMembers
            );
            require_keys_eq!(
                ctx.accounts.recipient_ata.owner,
                circle.members[recipient_index].key,
                SolaError::WrongRecipient
            );

            let contribution = circle.contribution;
            let member_count = circle.max_members as usize;
            let mut pot = 0u64;
            for member in circle.members.iter_mut().take(member_count) {
                let amount = if member.paid {
                    contribution
                } else {
                    let cover = contribution.min(member.collateral);
                    member.collateral -= cover;
                    if cover < contribution {
                        member.defaulted = true;
                    }
                    cover
                };
                pot = pot.checked_add(amount).ok_or(SolaError::MathOverflow)?;
                member.paid = false;
            }
            circle.members[recipient_index].received = true;
            (pot, circle.creator, circle.circle_id, circle.bump)
        };

        if pot > 0 {
            let circle_id_bytes = circle_id.to_le_bytes();
            let bump_seed = [bump];
            let seeds: &[&[u8]] = &[b"circle", creator.as_ref(), &circle_id_bytes, &bump_seed];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.recipient_ata.to_account_info(),
                        authority: ctx.accounts.circle.to_account_info(),
                    },
                    &[seeds],
                ),
                pot,
            )?;
        }

        let circle = &mut ctx.accounts.circle;
        circle.round += 1;
        if circle.round >= circle.max_members {
            circle.status = CircleStatus::Completed;
        } else {
            circle.round_start = now;
        }
        Ok(())
    }

    pub fn claim_collateral(ctx: Context<MemberAction>) -> Result<()> {
        let key = ctx.accounts.member.key();
        let (index, amount, creator, circle_id, bump) = {
            let circle = &ctx.accounts.circle;
            require!(
                circle.status == CircleStatus::Completed,
                SolaError::NotCompleted
            );
            let index = member_index(circle, &key)?;
            (
                index,
                circle.members[index].collateral,
                circle.creator,
                circle.circle_id,
                circle.bump,
            )
        };
        require!(amount > 0, SolaError::NothingToClaim);
        ctx.accounts.circle.members[index].collateral = 0;

        let circle_id_bytes = circle_id.to_le_bytes();
        let bump_seed = [bump];
        let seeds: &[&[u8]] = &[b"circle", creator.as_ref(), &circle_id_bytes, &bump_seed];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.member_ata.to_account_info(),
                    authority: ctx.accounts.circle.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }
}

fn member_index(circle: &Circle, key: &Pubkey) -> Result<usize> {
    circle
        .members
        .iter()
        .take(circle.joined as usize)
        .position(|member| member.key == *key)
        .ok_or_else(|| error!(SolaError::NotMember))
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Member {
    pub key: Pubkey,
    pub collateral: u64,
    pub paid: bool,
    pub received: bool,
    pub defaulted: bool,
}

impl Member {
    const SPACE: usize = 32 + 8 + 1 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum CircleStatus {
    Open,
    Active,
    Completed,
}

#[account]
pub struct Goal {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub goal_id: u64,
    pub name: String,
    pub target: u64,
    pub saved: u64,
    pub maturity_ts: i64,
    pub bump: u8,
}

impl Goal {
    const SPACE: usize = 32 + 32 + 8 + 4 + 32 + 8 + 8 + 8 + 1;
}

#[account]
pub struct Circle {
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub circle_id: u64,
    pub max_members: u8,
    pub joined: u8,
    pub contribution: u64,
    pub collateral: u64,
    pub cycle_secs: i64,
    pub status: CircleStatus,
    pub round: u8,
    pub round_start: i64,
    pub members: [Member; MAX_MEMBERS],
    pub bump: u8,
}

impl Circle {
    const SPACE: usize =
        32 + 32 + 8 + 1 + 1 + 8 + 8 + 8 + 1 + 1 + 8 + (Member::SPACE * MAX_MEMBERS) + 1;
}

#[derive(Accounts)]
#[instruction(goal_id: u64)]
pub struct CreateGoal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        space = 8 + Goal::SPACE,
        seeds = [b"goal", owner.key().as_ref(), &goal_id.to_le_bytes()],
        bump
    )]
    pub goal: Account<'info, Goal>,
    #[account(
        init,
        payer = owner,
        seeds = [b"goal_vault", goal.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = goal
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositGoal<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"goal", owner.key().as_ref(), &goal.goal_id.to_le_bytes()],
        bump = goal.bump,
        has_one = owner
    )]
    pub goal: Account<'info, Goal>,
    #[account(
        mut,
        seeds = [b"goal_vault", goal.key().as_ref()],
        bump,
        token::mint = goal.mint,
        token::authority = goal
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = goal.mint,
        token::authority = owner
    )]
    pub owner_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawGoal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        seeds = [b"goal", owner.key().as_ref(), &goal.goal_id.to_le_bytes()],
        bump = goal.bump,
        has_one = owner
    )]
    pub goal: Account<'info, Goal>,
    #[account(
        mut,
        seeds = [b"goal_vault", goal.key().as_ref()],
        bump,
        token::mint = goal.mint,
        token::authority = goal
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = goal.mint,
        token::authority = owner
    )]
    pub owner_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(circle_id: u64)]
pub struct CreateCircle<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = creator,
        space = 8 + Circle::SPACE,
        seeds = [b"circle", creator.key().as_ref(), &circle_id.to_le_bytes()],
        bump
    )]
    pub circle: Account<'info, Circle>,
    #[account(
        init,
        payer = creator,
        seeds = [b"circle_vault", circle.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = circle
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MemberAction<'info> {
    pub member: Signer<'info>,
    #[account(
        mut,
        seeds = [b"circle", circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump
    )]
    pub circle: Account<'info, Circle>,
    #[account(
        mut,
        seeds = [b"circle_vault", circle.key().as_ref()],
        bump,
        token::mint = circle.mint,
        token::authority = circle
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = circle.mint,
        token::authority = member
    )]
    pub member_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleRound<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [b"circle", circle.creator.as_ref(), &circle.circle_id.to_le_bytes()],
        bump = circle.bump
    )]
    pub circle: Account<'info, Circle>,
    #[account(
        mut,
        seeds = [b"circle_vault", circle.key().as_ref()],
        bump,
        token::mint = circle.mint,
        token::authority = circle
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = circle.mint)]
    pub recipient_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum SolaError {
    #[msg("Name must be 32 bytes or fewer.")]
    NameTooLong,
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Maturity must be in the future.")]
    MaturityInPast,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Goal funds are still locked.")]
    StillLocked,
    #[msg("Member count must be between 2 and 12.")]
    InvalidMembers,
    #[msg("Circle is not open for joining.")]
    NotOpen,
    #[msg("Wallet already joined this circle.")]
    AlreadyMember,
    #[msg("Circle is not active.")]
    NotActive,
    #[msg("The contribution window has closed.")]
    RoundClosed,
    #[msg("Member already contributed this round.")]
    AlreadyPaid,
    #[msg("The round window has not ended.")]
    RoundNotOver,
    #[msg("Recipient token account does not belong to this round's recipient.")]
    WrongRecipient,
    #[msg("Wallet is not a circle member.")]
    NotMember,
    #[msg("Circle is not completed.")]
    NotCompleted,
    #[msg("No collateral remains to claim.")]
    NothingToClaim,
}
