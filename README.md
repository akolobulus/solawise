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
and ticket escrow are not implemented.

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

The app defaults to the devnet USDC mint above. To use another classic SPL mint,
set `NEXT_PUBLIC_SOLAWISE_MINT` to its devnet address and ensure test tokens are
available to the wallets that will use the app.

```bash
npm run dev
```

Open `http://localhost:3000`, sign in through Pollar, and choose Phantom or
another external Solana wallet when prompted. Use devnet assets only.

## Deploy the Anchor program

Fund the deployment wallet with devnet SOL using the official Solana faucet,
then build and deploy:

```bash
anchor build
anchor program deploy --provider.cluster devnet --provider.wallet .anchor/wallet.json
```

If `anchor build` fails in this workspace with a missing
`librustc_driver` from platform-tools v1.57, build with the installed v1.58
toolchain:

```bash
cargo-build-sbf --tools-version v1.58 --manifest-path programs/solawise/Cargo.toml
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
ajo payout rotation, collateral coverage, and collateral claims:

```bash
anchor test
```

## Current scope

- Live Pollar wallet login, supported Solana transfers, balances, and history.
- On-chain goal vaults and ajo circles, once the program is deployed and the
  wallet has devnet SOL and tokens.
- No live NGN bill provider, Solana yield strategy, or ticket escrow.
