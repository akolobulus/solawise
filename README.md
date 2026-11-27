# SolaWise: Your Wealth Platform on Solana

SolaWise is a naira-first wealth platform built on Solana for goal-based
savings, rotating Ajo circles, ticket escrow and real wallet payments. It
combines an Anchor/Rust program with Pollar wallet infrastructure and a
server-side Groq assistant to make everyday wealth coordination transparent
and easy to use.

> SolaWise is an independent hackathon project and is not affiliated with
> Cowrywise or any other established financial institution.

## Submission summary

- **Short description:** Naira-first wealth app on Solana: goal vaults, Ajo
  circles, yield previews and event tickets. No crypto jargon.
- **Live demo:** `http://localhost:3000`
- **Category:** DeFi
- **Project title:** SolaWise: Your Wealth Platform on Solana
- **Program network:** Solana devnet
- **Program ID:** `7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h`
- **SPL asset:** Devnet USDC
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- **Primary wallet/payments provider:** Pollar SDK
- **Smart-contract framework:** Anchor 1.2.2 / Rust
- **Application framework:** Next.js 15 / React 19
- **Demo network:** Solana devnet only

## What SolaWise does

### SolaWise Goals

Users create named personal goal vaults with a target and maturity date.
Devnet USDC deposits are transferred into a PDA-owned SPL-token vault. The
vault and goal account enforce maturity before withdrawal and close after funds
leave the vault.

### SolaWise Ajo

Users create or join rotating savings circles. The join transaction locks
collateral in the circle vault, join order defines payout order, and
`settle_round` uses contribution transfers and remaining member collateral to
cover missed payments. Remaining collateral can be reclaimed after the circle
completes.

### SolaWise Events

Organizers create on-chain ticket events with an SPL-mint price and capacity.
Ticket purchases and resales are held in an event escrow vault. Resale prices
are capped at 110% of face value. An organizer can cancel an event and each
buyer or resale buyer can reclaim the full sale amount. After event completion,
the current seller can claim escrowed sale proceeds.

### SolaWise Pay

Pollar email-code auth powers the account and supported Pollar payment flows.
Phantom connects separately as the signer for SolaWise's custom Anchor
instructions, so users approve each real Solana devnet transaction in Phantom.
Pollar modals support send, receive, wallet balance, transaction history and
available local ramp routes. The Pollar integration uses testnet keys and
devnet SOL/test assets.

### SolaWise Assistant

The Assistant is a server-side Groq integration exposed through
`/api/assistant`. It accepts bounded chat history, applies a safety-oriented
savings-system prompt, validates messages and does not expose the Groq key to
the browser. Browser speech recognition can populate a question when supported.
The Assistant does not move funds or claim that financial actions occurred.

### SolaWise Home, Stash and Profile

Home shows live on-chain goal and Ajo counts. Stash shows the Pollar wallet,
Solana address and live returned balances. Profile shows Pollar signing mode,
wallet state and program readiness. Appearance settings support system, light
and dark themes.

## Why Solana

Solana provides fast confirmations and small network fees for frequent,
lower-value contributions. PDA-owned token vaults make savings, Ajo collateral,
ticket escrow and payout rules inspectable on-chain. SPL USDC provides
dollar-denominated test settlement, while Pollar handles wallet onboarding and
supported payment flows.

## Pollar integration

The app uses:

- `@pollar/core`
- `@pollar/react`
- `@pollar/solana-wallet-standard-adapter`

The browser provider uses a publishable test-mode key and cached client
configuration. Email-code login verifies Pollar auth. Pollar wallets use
`ON_DEMAND` or `AT_LOGIN` provisioning when configured in the dashboard.
The app does not use Pollar's wallet-login challenge: Phantom connects directly
and signs the custom Anchor transactions from the app's parent frame.

Pollar-managed custody is intentionally separated from external-wallet signing:
Pollar payment flows can operate on a Pollar wallet, while custom goal, Ajo and
ticket instructions require the connected Phantom signer. Supported Pollar
send/receive, balance and history modals are wired directly to the SDK. Pollar
is needed for the Pollar Payments track, but is not a requirement for Solana
devnet deployment or the overall/DeFi tracks.

## AI assistant integration

The Assistant uses a server-only `GROQ_API_KEY` and defaults to
`llama-3.3-70b-versatile`. Groq is called only from the Next.js server route.
Wallet addresses, balances and on-chain account data are not included in
assistant prompts. Invalid or provider-failed requests produce explicit UI
errors instead of canned success responses.

## Solana program architecture

The custom Rust/Anchor program implements:

- Personal goal accounts and PDA vaults
- Goal creation, SPL deposits and maturity-controlled withdrawal
- Ajo creation, joining, collateral, contributions and round settlement
- Automatic collateral coverage for missed Ajo payments
- Collateral reclaim after circle completion
- Event, ticket and ticket-sale accounts
- 10%-capped resale
- Event cancellation refunds
- Post-event sale settlement

The program PDA namespaces include `goal`, `goal_vault`, `circle`,
`circle_vault`, `event`, `event_vault`, `ticket` and `ticket_sale`.

## Devnet deployment

- Program: `7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h`
- Cluster: Solana devnet
- Address:
  [SolaWise devnet program](https://explorer.solana.com/address/7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h?cluster=devnet)
- Devnet USDC mint:
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- IDL metadata account:
  `HEnji31L78CFZtVNz4pmkXe9QMwqYJsPaxPKXpJqvxF`

## Local setup

Requirements: Node.js 22+, npm, Rust, Solana CLI and Anchor 1.2.2.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Set these environment variables in `.env.local`:

```text
NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY=<Pollar test-mode publishable key>
POLLAR_SECRET_KEY=<Pollar server-only secret>
GROQ_API_KEY=<Groq server-only key>
GROQ_MODEL=llama-3.3-70b-versatile
NEXT_PUBLIC_SOLAWISE_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

Never prefix the Pollar secret or Groq key with `NEXT_PUBLIC_`.

In the Pollar dashboard:

1. Allow `http://localhost:3000` and the deployed demo origin.
2. Enable Solana on testnet.
3. Set wallet provisioning to `ON_DEMAND` or `AT_LOGIN`.
4. Enable the supported Solana assets that should appear in balances.
5. Confirm send, receive and local-ramp routes for the demo.

Open `http://localhost:3000`, sign in with Pollar email verification or
connect a Wallet Standard wallet, and use devnet assets only.

## Build and deploy

If the standard `anchor build` toolchain reports a missing
`librustc_driver` from platform-tools v1.57, build with v1.58:

```bash
cargo-build-sbf --tools-version v1.58 \
  --manifest-path programs/solawise/Cargo.toml
anchor idl build -p solawise \
  -o target/idl/solawise.json \
  -t target/types/solawise.ts
```

Deploy or upgrade the program:

```bash
solana program deploy target/deploy/solawise.so \
  --program-id 7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h \
  --upgrade-authority .anchor/wallet.json \
  --keypair .anchor/wallet.json \
  --url devnet \
  --max-len 500000

anchor idl upgrade \
  --filepath target/idl/solawise.json \
  7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h \
  --provider.cluster devnet \
  --provider.wallet .anchor/wallet.json
```

Never publish `.anchor/wallet.json` or any keypair/secret.

## Tests

The integration suite uses a local SPL mint and a local Solana validator. It
covers:

- Goal maturity lock and post-maturity withdrawal
- Ajo join order, payouts and missed-payment collateral
- Remaining Ajo collateral claims
- Ticket resale at the 10% cap
- Ticket unlisting
- Full refunds for original and resale purchases after cancellation
- Escrow payout only after event completion

```bash
anchor test --skip-build --validator legacy
npm run build
```

## Demo flow

1. Open SolaWise and connect Pollar email or a Solana wallet.
2. Open Stash and confirm the Pollar Solana address and wallet balance.
3. Open Save and create or fund an on-chain goal.
4. Create an Ajo, join members and settle a round.
5. Open Events and create or browse an on-chain ticket event.
6. Purchase, resell, cancel or settle a devnet ticket according to the
   event lifecycle.
7. Open Pay to use Pollar send/receive/balance/history or enabled ramp routes.
8. Open Assistant for server-side AI guidance.

## Submission track fit

- **Best App Overall / unique Rust project:** custom Anchor PDA accounts,
  devnet deployment, goal/Ajo/ticket escrow and a complete React wallet UX.
- **Best DeFi App:** on-chain vaults, collateralized rotating savings and
  escrowed ticket settlement.
- **Best Agentic App:** server-side Groq Assistant with bounded chat history;
  Pollar payment context and on-chain account context keep user interactions grounded
  in Solana devnet state.
- **Pollar Payments:** Pollar SDK login, external wallet discovery, wallet
  provisioning, send/receive, balance, history and ramp integration.

## Prototype scope

SolaWise uses Solana devnet test assets and is a non-custodial hackathon
prototype, not a regulated financial product. Live yield protocol selection,
Nigerian bill-provider credentials and live NGN ramp settlement require
external providers and should be enabled only when those integrations are
fully verified. Pollar routes and Groq API calls are real integrations from
the server or browser.
