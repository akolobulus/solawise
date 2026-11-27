import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import BN from "bn.js";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import { Solawise } from "../target/types/solawise";

describe("solawise", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solawise as Program<Solawise>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const sleep = (seconds: number) =>
    new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
  const u64 = (value: number) => new BN(value).toArrayLike(Buffer, "le", 8);
  const pda = (seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const balance = async (account: PublicKey) =>
    Number((await getAccount(connection, account)).amount);
  const START = 1_000_000;
  let mint: PublicKey;

  async function createUser() {
    const keypair = Keypair.generate();
    const signature = await connection.requestAirdrop(
      keypair.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      ...latestBlockhash,
    });
    const tokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        keypair.publicKey,
      )
    ).address;
    await mintTo(connection, payer, mint, tokenAccount, payer, START);
    return { keypair, tokenAccount };
  }

  before(async () => {
    mint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      6,
    );
  });

  it("locks a goal until maturity, then withdraws and closes it", async function () {
    this.timeout(60_000);
    const user = await createUser();
    const id = 1;
    const goal = pda([
      Buffer.from("goal"),
      user.keypair.publicKey.toBuffer(),
      u64(id),
    ]);
    const vault = pda([Buffer.from("goal_vault"), goal.toBuffer()]);
    const maturity = Math.floor(Date.now() / 1_000) + 4;

    await program.methods
      .createGoal(new BN(id), "Rent", new BN(500_000), new BN(maturity))
      .accountsPartial({
        owner: user.keypair.publicKey,
        mint,
        goal,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user.keypair])
      .rpc();

    await program.methods
      .depositGoal(new BN(300_000))
      .accountsPartial({
        owner: user.keypair.publicKey,
        goal,
        vault,
        ownerAta: user.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user.keypair])
      .rpc();
    assert.equal(await balance(vault), 300_000);

    const withdraw = () =>
      program.methods
        .withdrawGoal()
        .accountsPartial({
          owner: user.keypair.publicKey,
          goal,
          vault,
          ownerAta: user.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user.keypair])
        .rpc();

    let blocked = false;
    try {
      await withdraw();
    } catch {
      blocked = true;
    }
    assert.isTrue(blocked, "early withdrawal must fail");

    await sleep(8);
    await withdraw();
    assert.equal(await balance(user.tokenAccount), START);
    assert.isNull(await connection.getAccountInfo(goal), "goal account closed");
  });

  it("rotates circle payouts, covers a default with collateral, and returns remaining collateral", async function () {
    this.timeout(120_000);
    const users = [await createUser(), await createUser(), await createUser()];
    const [user0, user1, user2] = users;
    const id = 7;
    const contribution = 100;
    const collateral = 100;
    const cycle = 6;
    const circle = pda([
      Buffer.from("circle"),
      user0.keypair.publicKey.toBuffer(),
      u64(id),
    ]);
    const vault = pda([Buffer.from("circle_vault"), circle.toBuffer()]);

    await program.methods
      .createCircle(
        new BN(id),
        3,
        new BN(contribution),
        new BN(collateral),
        new BN(cycle),
      )
      .accountsPartial({
        creator: user0.keypair.publicKey,
        mint,
        circle,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user0.keypair])
      .rpc();

    const memberAccounts = (user: (typeof users)[number]) => ({
      member: user.keypair.publicKey,
      circle,
      vault,
      memberAta: user.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
    const join = (user: (typeof users)[number]) =>
      program.methods
        .joinCircle()
        .accountsPartial(memberAccounts(user))
        .signers([user.keypair])
        .rpc();
    const contribute = (user: (typeof users)[number]) =>
      program.methods
        .contribute()
        .accountsPartial(memberAccounts(user))
        .signers([user.keypair])
        .rpc();
    const settle = (recipient: (typeof users)[number]) =>
      program.methods
        .settleRound()
        .accountsPartial({
          caller: payer.publicKey,
          circle,
          vault,
          recipientAta: recipient.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

    for (const user of users) await join(user);
    assert.equal(await balance(vault), collateral * 3);

    await contribute(user0);
    await contribute(user1);
    await sleep(cycle + 4);
    await settle(user0);
    assert.equal(
      await balance(user0.tokenAccount),
      START - collateral - contribution + 300,
    );

    for (const recipient of [user1, user2]) {
      for (const user of users) await contribute(user);
      await sleep(cycle + 4);
      await settle(recipient);
    }

    const claimCollateral = (user: (typeof users)[number]) =>
      program.methods
        .claimCollateral()
        .accountsPartial(memberAccounts(user))
        .signers([user.keypair])
        .rpc();
    await claimCollateral(user0);
    await claimCollateral(user1);

    let nothingToClaim = false;
    try {
      await claimCollateral(user2);
    } catch {
      nothingToClaim = true;
    }
    assert.isTrue(nothingToClaim, "defaulting member has no collateral left");

    for (const user of users) {
      assert.equal(await balance(user.tokenAccount), START, "everyone nets zero");
    }
    assert.equal(await balance(vault), 0, "circle vault is drained");
  });
});
