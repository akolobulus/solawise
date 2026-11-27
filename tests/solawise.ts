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

  it("caps ticket resale and fully refunds each sale when an event is cancelled", async function () {
    this.timeout(60_000);
    const [organizer, firstBuyer, secondBuyer] = [
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const eventId = 18;
    const event = pda([
      Buffer.from("event"),
      organizer.keypair.publicKey.toBuffer(),
      u64(eventId),
    ]);
    const vault = pda([Buffer.from("event_vault"), event.toBuffer()]);
    const ticket = pda([
      Buffer.from("ticket"),
      event.toBuffer(),
      Buffer.from([0, 0, 0, 0]),
    ]);
    const sale0 = pda([
      Buffer.from("ticket_sale"),
      event.toBuffer(),
      u64(0),
    ]);
    const sale1 = pda([
      Buffer.from("ticket_sale"),
      event.toBuffer(),
      u64(1),
    ]);
    const eventTs = Math.floor(Date.now() / 1_000) + 30;

    await program.methods
      .createEvent(new BN(eventId), "Community Music Night", new BN(eventTs), new BN(1_000), 2)
      .accountsPartial({
        organizer: organizer.keypair.publicKey,
        mint,
        event,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([organizer.keypair])
      .rpc();

    await program.methods
      .buyTicket(0, new BN(0))
      .accountsPartial({
        buyer: firstBuyer.keypair.publicKey,
        event,
        ticket,
        sale: sale0,
        vault,
        buyerAta: firstBuyer.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([firstBuyer.keypair])
      .rpc();

    let resaleRejected = false;
    try {
      await program.methods
        .listTicket(new BN(1_101))
        .accountsPartial({
          owner: firstBuyer.keypair.publicKey,
          event,
          ticket,
        })
        .signers([firstBuyer.keypair])
        .rpc();
    } catch {
      resaleRejected = true;
    }
    assert.isTrue(resaleRejected, "resale above 110% of face value must fail");

    await program.methods
      .listTicket(new BN(1_100))
      .accountsPartial({
        owner: firstBuyer.keypair.publicKey,
        event,
        ticket,
      })
      .signers([firstBuyer.keypair])
      .rpc();
    await program.methods
      .unlistTicket()
      .accountsPartial({
        owner: firstBuyer.keypair.publicKey,
        event,
        ticket,
      })
      .signers([firstBuyer.keypair])
      .rpc();

    await program.methods
      .listTicket(new BN(1_100))
      .accountsPartial({
        owner: firstBuyer.keypair.publicKey,
        event,
        ticket,
      })
      .signers([firstBuyer.keypair])
      .rpc();

    await program.methods
      .buyResale(new BN(1))
      .accountsPartial({
        buyer: secondBuyer.keypair.publicKey,
        event,
        ticket,
        sale: sale1,
        vault,
        buyerAta: secondBuyer.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([secondBuyer.keypair])
      .rpc();
    assert.equal(await balance(vault), 2_100);

    await program.methods
      .cancelEvent()
      .accountsPartial({
        organizer: organizer.keypair.publicKey,
        event,
      })
      .signers([organizer.keypair])
      .rpc();

    const refund = async (
      sale: PublicKey,
      buyer: (typeof firstBuyer) | (typeof secondBuyer),
    ) =>
      program.methods
        .refundTicketSale()
        .accountsPartial({
          event,
          sale,
          vault,
          buyer: buyer.keypair.publicKey,
          buyerAta: buyer.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer.keypair])
        .rpc();

    await refund(sale0, firstBuyer);
    await refund(sale1, secondBuyer);
    assert.equal(await balance(firstBuyer.tokenAccount), START);
    assert.equal(await balance(secondBuyer.tokenAccount), START);
    assert.equal(await balance(vault), 0);
    assert.isNull(await connection.getAccountInfo(sale0));
    assert.isNull(await connection.getAccountInfo(sale1));
  });

  it("pays ticket sale proceeds to the seller only after the event ends", async function () {
    this.timeout(60_000);
    const [organizer, buyer] = [await createUser(), await createUser()];
    const eventId = 19;
    const event = pda([
      Buffer.from("event"),
      organizer.keypair.publicKey.toBuffer(),
      u64(eventId),
    ]);
    const vault = pda([Buffer.from("event_vault"), event.toBuffer()]);
    const ticket = pda([
      Buffer.from("ticket"),
      event.toBuffer(),
      Buffer.from([0, 0, 0, 0]),
    ]);
    const sale = pda([
      Buffer.from("ticket_sale"),
      event.toBuffer(),
      u64(0),
    ]);
    const eventTs = Math.floor(Date.now() / 1_000) + 4;

    await program.methods
      .createEvent(new BN(eventId), "Community Workshop", new BN(eventTs), new BN(2_000), 1)
      .accountsPartial({
        organizer: organizer.keypair.publicKey,
        mint,
        event,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([organizer.keypair])
      .rpc();
    await program.methods
      .buyTicket(0, new BN(0))
      .accountsPartial({
        buyer: buyer.keypair.publicKey,
        event,
        ticket,
        sale,
        vault,
        buyerAta: buyer.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer.keypair])
      .rpc();

    let earlySettlementRejected = false;
    try {
      await program.methods
        .settleTicketSale()
        .accountsPartial({
          event,
          sale,
          vault,
          seller: organizer.keypair.publicKey,
          sellerAta: organizer.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([organizer.keypair])
        .rpc();
    } catch {
      earlySettlementRejected = true;
    }
    assert.isTrue(earlySettlementRejected, "sale proceeds must stay escrowed before event end");

    await sleep(5);
    await program.methods
      .completeEvent()
      .accountsPartial({
        caller: organizer.keypair.publicKey,
        event,
      })
      .signers([organizer.keypair])
      .rpc();
    await program.methods
      .settleTicketSale()
      .accountsPartial({
        event,
        sale,
        vault,
        seller: organizer.keypair.publicKey,
        sellerAta: organizer.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([organizer.keypair])
      .rpc();

    assert.equal(await balance(buyer.tokenAccount), START - 2_000);
    assert.equal(await balance(organizer.tokenAccount), START + 2_000);
    assert.equal(await balance(vault), 0);
  });
});
