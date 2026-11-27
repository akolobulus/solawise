# SolaWise

SolaWise is a Solana savings app for personal goal vaults and rotating ajo
circles. It uses an Anchor program for escrow and settlement, Phantom-compatible
wallets for transaction approval, and Pollar for wallet login and supported
Solana payments.

## Network and program

- App network: Solana devnet (test tokens only).
- Program ID: `7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h`
- Deployment status: deployed and verified executable on Solana devnet.
- Explorer:
  [View the devnet program](https://explorer.solana.com/address/7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h?cluster=devnet).
- On-chain IDL metadata account:
  `HEnji31L78CFZtVNz4pmkXe9QMwqYJsPaxPKXpJqvxF`.
- Default goal/ajo asset: devnet USDC,
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

The app does not simulate balances, transfers, savings, or ticket purchases.
Goals and ajo circles require the deployed program, a Phantom-compatible
external wallet, devnet SOL for transaction fees, and a balance of the selected
SPL mint. Pollar-managed wallets can use Pollar payment features but cannot
currently sign these custom Anchor instructions. Naira ramps and bill payments
are only available if enabled by Pollar; SolaWise has no NGN provider. Yield
strategies remain unavailable until a Solana provider is selected.

Ticket events are organizer-created on devnet. Ticket payments and resale
payments are held in program escrow until the event ends; sellers can then
claim proceeds. Organizer cancellation enables a full refund for every ticket
purchase and resale. Resale prices are capped at 110% of ticket face value.

## Local setup

Requirements: Node.js, Yarn or npm, Rust, Solana CLI, and Anchor CLI compatible
with this project's Anchor dependencies.

```bash
npm ci
cp .env.example .env.local
```

In `.env.local`, set `NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY` to a Pollar test-mode
publishable key and `POLLAR_SECRET_KEY` to the server-only secret. Never use a
`NEXT_PUBLIC_` prefix for the secret. The browser SDK flows use the publishable
key; the server secret is not currently used by SolaWise.

To enable the SolaWise Assistant, add a Groq API key as `GROQ_API_KEY` in
`.env.local`. This key is used only by the server-side `/api/assistant` route;
never expose it with a `NEXT_PUBLIC_` prefix. The optional `GROQ_MODEL` setting
defaults to `llama-3.3-70b-versatile`. Without a valid key, assistant requests
show an explicit provider/configuration error and do not fall back to canned
answers. User prompts are sent to Groq; wallet addresses, balances, and
on-chain account data are not included.

In the Pollar dashboard, allow `http://localhost:3000` as an app origin, enable
the Solana chain on testnet, and set wallet provisioning to `ON_DEMAND` or
`AT_LOGIN`. `ON_DEMAND` creates the Pollar wallet after verified email login;
Phantom and other detected Solana wallets remain available as external wallets.
Pollar rejects SDK requests from origins that are not allowlisted.

The app defaults to the devnet USDC mint above. To use another classic SPL mint,
set `NEXT_PUBLIC_SOLAWISE_MINT` to its devnet address and ensure test tokens are
available to the wallets that will use the app.

```bash
npm run dev
```

Open `http://localhost:3000` and either sign in with a Pollar email code or
connect Phantom (or another detected Solana wallet). Use devnet assets only.

## Deploy the Anchor program

Fund the deployment wallet with devnet SOL using the official Solana faucet,
then build and deploy:

```bash
cargo-build-sbf --tools-version v1.58 --manifest-path programs/solawise/Cargo.toml
anchor idl build -p solawise -o target/idl/solawise.json -t target/types/solawise.ts
solana program deploy target/deploy/solawise.so \
  --program-id 7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h \
  --upgrade-authority .anchor/wallet.json \
  --keypair .anchor/wallet.json \
  --url devnet \
  --max-len 500000
anchor idl upgrade --filepath target/idl/solawise.json \
  7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h \
  --provider.cluster devnet \
  --provider.wallet .anchor/wallet.json
```

If `anchor build` fails in this workspace with a missing
`librustc_driver` from platform-tools v1.57, build with the v1.58 toolchain,
generate the IDL, and run tests against the compiled SBF binary:

```bash
cargo-build-sbf --tools-version v1.58 --manifest-path programs/solawise/Cargo.toml
anchor idl build -p solawise -o target/idl/solawise.json -t target/types/solawise.ts
anchor test --skip-build --validator legacy
```

The deployment wallet must match the keypair in `.anchor/wallet.json`; never
publish that file. After deployment, verify the program account on devnet:

```bash
solana account 7g5t6wDmwmNsgSxTJKqy3gbck2PYRqTsKjXj6PGgq16h --url devnet
```

The configured program ID must continue to match `declare_id!` in
`programs/solawise/src/lib.rs`.

## Tests

The Anchor integration tests create a local SPL mint and cover goal maturity,
ajo payout rotation and collateral claims, as well as ticket resale limits,
event cancellation refunds, and post-event escrow payouts:

```bash
anchor test --skip-build --validator legacy
```

## Current scope

- Live Pollar wallet login, supported Solana transfers, balances, and history.
- Server-side Groq-powered assistant, when `GROQ_API_KEY` is configured.
- On-chain goal vaults and ajo circles, once the program is deployed and the
  wallet has devnet SOL and tokens.
- Organizer-created devnet ticket events, escrow purchases, 10%-capped resale,
  cancellation refunds, and post-event seller payouts.
- No live NGN bill provider or Solana yield strategy.
