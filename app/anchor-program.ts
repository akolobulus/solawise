import { AnchorProvider, Program } from "@anchor-lang/core";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  clusterApiUrl,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import type { PollarClient } from "@pollar/core";
import idl from "../target/idl/solawise.json";
import type { Solawise } from "../target/types/solawise";

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export type GoalSnapshot = {
  address: string;
  name: string;
  target: string;
  saved: string;
  maturityTs: number;
};

export type CircleSnapshot = {
  address: string;
  name: string;
  contribution: string;
  collateral: string;
  cycleSecs: number;
  maxMembers: number;
  joined: number;
  round: number;
  roundStart: number;
  status: string;
  members: Array<{
    address: string;
    collateral: string;
    paid: boolean;
    received: boolean;
    defaulted: boolean;
  }>;
};

export type EventSnapshot = {
  address: string;
  organizer: string;
  title: string;
  eventTs: number;
  ticketPrice: string;
  capacity: number;
  soldCount: number;
  nextSaleId: string;
  status: string;
};

export type TicketSnapshot = {
  address: string;
  event: string;
  ticketId: number;
  owner: string;
  facePrice: string;
  askingPrice: string;
  status: string;
};

export type TicketSaleSnapshot = {
  address: string;
  event: string;
  ticket: string;
  seller: string;
  buyer: string;
  amount: string;
  saleId: string;
};

export type ProgramSnapshot = {
  configured: boolean;
  deployed: boolean;
  walletAddress: string | null;
  walletCustody: string | null;
  mint: string | null;
  decimals: number | null;
  goals: GoalSnapshot[];
  circles: CircleSnapshot[];
  events: EventSnapshot[];
  tickets: TicketSnapshot[];
  ticketSales: TicketSaleSnapshot[];
  message: string | null;
};

export type ProgramAction =
  | { action: "create-goal"; name: string; target: string; maturityDate: string }
  | { action: "deposit-goal"; goal: string; amount: string }
  | { action: "withdraw-goal"; goal: string }
  | {
      action: "create-circle";
      maxMembers: string;
      contribution: string;
      collateral: string;
      cycleSecs: string;
    }
  | { action: "join-circle"; circle: string }
  | { action: "contribute"; circle: string }
  | { action: "settle-round"; circle: string }
  | { action: "claim-collateral"; circle: string }
  | {
      action: "create-event";
      title: string;
      eventDate: string;
      ticketPrice: string;
      capacity: string;
    }
  | { action: "buy-ticket"; event: string }
  | { action: "list-ticket"; ticket: string; askingPrice: string }
  | { action: "unlist-ticket"; ticket: string }
  | { action: "buy-resale"; ticket: string }
  | { action: "cancel-event"; event: string }
  | { action: "complete-event"; event: string }
  | { action: "refund-ticket-sale"; sale: string }
  | { action: "settle-ticket-sale"; sale: string };

export type SolanaTransactionSigner = {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[]>;
};

export function parseProgramAction(value: unknown): ProgramAction | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;

  switch (request.action) {
    case "create-goal":
      return typeof request.name === "string" &&
        typeof request.target === "string" &&
        typeof request.maturityDate === "string"
        ? {
            action: "create-goal",
            name: request.name,
            target: request.target,
            maturityDate: request.maturityDate,
          }
        : null;
    case "deposit-goal":
      return typeof request.goal === "string" &&
        typeof request.amount === "string"
        ? {
            action: "deposit-goal",
            goal: request.goal,
            amount: request.amount,
          }
        : null;
    case "withdraw-goal":
      return typeof request.goal === "string"
        ? { action: "withdraw-goal", goal: request.goal }
        : null;
    case "create-circle":
      return typeof request.maxMembers === "string" &&
        typeof request.contribution === "string" &&
        typeof request.collateral === "string" &&
        typeof request.cycleSecs === "string"
        ? {
            action: "create-circle",
            maxMembers: request.maxMembers,
            contribution: request.contribution,
            collateral: request.collateral,
            cycleSecs: request.cycleSecs,
          }
        : null;
    case "join-circle":
      return typeof request.circle === "string"
        ? { action: "join-circle", circle: request.circle }
        : null;
    case "contribute":
      return typeof request.circle === "string"
        ? { action: "contribute", circle: request.circle }
        : null;
    case "settle-round":
      return typeof request.circle === "string"
        ? { action: "settle-round", circle: request.circle }
        : null;
    case "claim-collateral":
      return typeof request.circle === "string"
        ? { action: "claim-collateral", circle: request.circle }
        : null;
    case "create-event":
      return typeof request.title === "string" &&
        typeof request.eventDate === "string" &&
        typeof request.ticketPrice === "string" &&
        typeof request.capacity === "string"
        ? {
            action: "create-event",
            title: request.title,
            eventDate: request.eventDate,
            ticketPrice: request.ticketPrice,
            capacity: request.capacity,
          }
        : null;
    case "buy-ticket":
    case "cancel-event":
    case "complete-event":
      return typeof request.event === "string"
        ? { action: request.action, event: request.event }
        : null;
    case "list-ticket":
      return typeof request.ticket === "string" &&
        typeof request.askingPrice === "string"
        ? {
            action: "list-ticket",
            ticket: request.ticket,
            askingPrice: request.askingPrice,
          }
        : null;
    case "unlist-ticket":
    case "buy-resale":
      return typeof request.ticket === "string"
        ? { action: request.action, ticket: request.ticket }
        : null;
    case "refund-ticket-sale":
    case "settle-ticket-sale":
      return typeof request.sale === "string"
        ? { action: request.action, sale: request.sale }
        : null;
    default:
      return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function amountToBaseUnits(value: string, decimals: number): BN {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || decimals < 0 || decimals > 18) {
    throw new Error("Enter a valid positive token amount.");
  }

  const whole = match[1];
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`This token supports at most ${decimals} decimal places.`);
  }

  const scale = new BN(10).pow(new BN(decimals));
  const raw = new BN(whole, 10)
    .mul(scale)
    .add(new BN(fraction.padEnd(decimals, "0") || "0", 10));
  if (
    raw.isZero() ||
    raw.gt(new BN("18446744073709551615", 10))
  ) {
    throw new Error("Amount must fit in a positive SPL-token u64.");
  }
  return raw;
}

function circleStatus(status: unknown): string {
  if (typeof status === "string") return status.toLowerCase();
  if (status && typeof status === "object") {
    const [value] = Object.keys(status);
    if (value) return value.toLowerCase();
  }
  return "unknown";
}

function makeProgram(client: PollarClient, owner: PublicKey) {
  const provider = new AnchorProvider(connection, makeProgramWallet(client, owner), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return new Program<Solawise>(idl as Solawise, provider);
}

function readMintAddress(): PublicKey {
  const value = process.env.NEXT_PUBLIC_SOLAWISE_MINT || DEVNET_USDC_MINT;
  try {
    return new PublicKey(value);
  } catch {
    throw new Error("NEXT_PUBLIC_SOLAWISE_MINT is not a valid Solana address.");
  }
}

function newId(): BN {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return new BN(Date.now())
    .mul(new BN(1_000_000))
    .add(new BN(random[0] % 1_000_000));
}

async function createOwnerAtaIfMissing(
  owner: PublicKey,
  mint: PublicKey,
): Promise<Transaction | null> {
  const address = getAssociatedTokenAddressSync(mint, owner);
  if (await connection.getAccountInfo(address, "confirmed")) return null;
  return new Transaction().add(
    createAssociatedTokenAccountInstruction(owner, address, owner, mint),
  );
}

function requirePublicKey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid Solana address.`);
  }
}

export async function getProgramSnapshot(
  client: PollarClient | null,
  walletAddress: string | null,
  walletCustody: string | null,
): Promise<ProgramSnapshot> {
  const empty: ProgramSnapshot = {
    configured: false,
    deployed: false,
    walletAddress,
    walletCustody,
    mint: null,
    decimals: null,
    goals: [],
    circles: [],
    events: [],
    tickets: [],
    ticketSales: [],
    message: null,
  };

  if (!client || !walletAddress) {
    return {
      ...empty,
      message: !client
        ? "Sign in with Pollar to load your devnet accounts."
        : "Connect Phantom to load your devnet accounts.",
    };
  }

  let mint: PublicKey;
  try {
    mint = readMintAddress();
  } catch (error) {
    return {
      ...empty,
      message: error instanceof Error ? error.message : "The SPL mint is not configured.",
    };
  }

  try {
    const owner = requirePublicKey(walletAddress, "Pollar wallet");
    const program = makeProgram(client, owner);
    const mintInfo = await getMint(connection, mint, "confirmed");
    const deployed = await connection.getAccountInfo(program.programId, "confirmed");
    if (!deployed?.executable) {
      return {
        ...empty,
        configured: true,
        walletAddress,
        walletCustody,
        mint: mint.toBase58(),
        decimals: mintInfo.decimals,
        message: "The SolaWise program is not deployed to Solana devnet yet.",
      };
    }

    const [goals, allCircles, allEvents, allTickets, allTicketSales] = await Promise.all([
      program.account.goal.all(),
      program.account.circle.all(),
      program.account.event.all(),
      program.account.ticket.all(),
      program.account.ticketSale.all(),
    ]);
    const ownerGoals = goals
      .filter(({ account }) => account.owner.equals(owner))
      .map(({ publicKey, account }) => ({
        address: publicKey.toBase58(),
        name: account.name,
        target: account.target.toString(),
        saved: account.saved.toString(),
        maturityTs: account.maturityTs.toNumber(),
      }));
    const ownerCircles = allCircles
      .filter(
        ({ account }) =>
          account.creator.equals(owner) ||
          account.members
            .slice(0, account.joined)
            .some((member) => member.key.equals(owner)),
      )
      .map(({ publicKey, account }) => ({
        address: publicKey.toBase58(),
        name: `Ajo ${account.circleId.toString()}`,
        contribution: account.contribution.toString(),
        collateral: account.collateral.toString(),
        cycleSecs: account.cycleSecs.toNumber(),
        maxMembers: account.maxMembers,
        joined: account.joined,
        round: account.round,
        roundStart: account.roundStart.toNumber(),
        status: circleStatus(account.status),
        members: account.members.slice(0, account.joined).map((member) => ({
          address: member.key.toBase58(),
          collateral: member.collateral.toString(),
          paid: member.paid,
          received: member.received,
          defaulted: member.defaulted,
        })),
      }));
    const events = allEvents
      .filter(({ account }) => account.mint.equals(mint))
      .map(({ publicKey, account }) => ({
        address: publicKey.toBase58(),
        organizer: account.organizer.toBase58(),
        title: account.title,
        eventTs: account.eventTs.toNumber(),
        ticketPrice: account.ticketPrice.toString(),
        capacity: account.capacity,
        soldCount: account.soldCount,
        nextSaleId: account.nextSaleId.toString(),
        status: circleStatus(account.status),
      }));
    const eventAddresses = new Set(events.map((event) => event.address));
    const tickets = allTickets
      .filter(
        ({ account }) =>
          eventAddresses.has(account.event.toBase58()) &&
          (account.owner.equals(owner) || circleStatus(account.status) === "listed"),
      )
      .map(({ publicKey, account }) => ({
        address: publicKey.toBase58(),
        event: account.event.toBase58(),
        ticketId: account.ticketId,
        owner: account.owner.toBase58(),
        facePrice: account.facePrice.toString(),
        askingPrice: account.askingPrice.toString(),
        status: circleStatus(account.status),
      }));
    const ticketSales = allTicketSales
      .filter(
        ({ account }) =>
          eventAddresses.has(account.event.toBase58()) &&
          (account.buyer.equals(owner) || account.seller.equals(owner)),
      )
      .map(({ publicKey, account }) => ({
        address: publicKey.toBase58(),
        event: account.event.toBase58(),
        ticket: account.ticket.toBase58(),
        seller: account.seller.toBase58(),
        buyer: account.buyer.toBase58(),
        amount: account.amount.toString(),
        saleId: account.saleId.toString(),
      }));

    return {
      ...empty,
      configured: true,
      deployed: true,
      mint: mint.toBase58(),
      decimals: mintInfo.decimals,
      goals: ownerGoals,
      circles: ownerCircles,
      events,
      tickets,
      ticketSales,
      message: null,
    };
  } catch (error) {
    return {
      ...empty,
      configured: true,
      mint: mint.toBase58(),
      message:
        error instanceof Error
          ? error.message
          : "Could not read the SolaWise devnet accounts.",
    };
  }
}

export async function runProgramAction(
  client: PollarClient,
  walletAddress: string,
  request: ProgramAction,
  signer: SolanaTransactionSigner,
): Promise<string> {
  if (!process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY?.startsWith("pub_testnet_")) {
    throw new Error("SolaWise program actions are restricted to Pollar Test mode.");
  }

  const owner = requirePublicKey(walletAddress, "Phantom wallet");
  if (!signer.publicKey.equals(owner)) {
    throw new Error("The connected Phantom account changed. Reconnect and try again.");
  }
  const mint = readMintAddress();
  const program = makeProgram(client, owner);
  const mintInfo = await getMint(connection, mint, "confirmed");
  const ownerAta = getAssociatedTokenAddressSync(mint, owner);
  const transaction = (await createOwnerAtaIfMissing(owner, mint)) ?? new Transaction();

  switch (request.action) {
    case "create-goal": {
      const name = request.name.trim();
      if (!name || new TextEncoder().encode(name).length > 32) {
        throw new Error("Goal name must be between 1 and 32 UTF-8 bytes.");
      }
      const maturity = new Date(`${request.maturityDate}T23:59:59`);
      if (!Number.isFinite(maturity.getTime()) || maturity.getTime() <= Date.now()) {
        throw new Error("Choose a maturity date in the future.");
      }
      const id = newId();
      const [goal] = PublicKey.findProgramAddressSync(
        [Buffer.from("goal"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
        program.programId,
      );
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("goal_vault"), goal.toBuffer()],
        program.programId,
      );
      transaction.add(
        await program.methods
          .createGoal(
            id,
            name,
            amountToBaseUnits(request.target, mintInfo.decimals),
            new BN(Math.floor(maturity.getTime() / 1000)),
          )
          .accountsPartial({
            owner,
            mint,
            goal,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
      break;
    }
    case "deposit-goal": {
      const goal = requirePublicKey(request.goal, "Goal");
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("goal_vault"), goal.toBuffer()],
        program.programId,
      );
      transaction.add(
        await program.methods
          .depositGoal(amountToBaseUnits(request.amount, mintInfo.decimals))
          .accountsPartial({
            owner,
            goal,
            vault,
            ownerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      );
      break;
    }
    case "withdraw-goal": {
      const goal = requirePublicKey(request.goal, "Goal");
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("goal_vault"), goal.toBuffer()],
        program.programId,
      );
      transaction.add(
        await program.methods
          .withdrawGoal()
          .accountsPartial({
            owner,
            goal,
            vault,
            ownerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      );
      break;
    }
    case "create-circle": {
      const maxMembers = Number(request.maxMembers);
      const cycleSecs = Number(request.cycleSecs);
      if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 12) {
        throw new Error("A circle must have between 2 and 12 members.");
      }
      if (!Number.isSafeInteger(cycleSecs) || cycleSecs < 1) {
        throw new Error("Cycle duration must be a positive number of seconds.");
      }
      const id = newId();
      const [circle] = PublicKey.findProgramAddressSync(
        [Buffer.from("circle"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
        program.programId,
      );
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("circle_vault"), circle.toBuffer()],
        program.programId,
      );
      transaction.add(
        await program.methods
          .createCircle(
            id,
            maxMembers,
            amountToBaseUnits(request.contribution, mintInfo.decimals),
            amountToBaseUnits(request.collateral, mintInfo.decimals),
            new BN(cycleSecs),
          )
          .accountsPartial({
            creator: owner,
            mint,
            circle,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
      break;
    }
    case "join-circle":
    case "contribute":
    case "claim-collateral": {
      const circle = requirePublicKey(request.circle, "Circle");
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("circle_vault"), circle.toBuffer()],
        program.programId,
      );
      const method =
        request.action === "join-circle"
          ? program.methods.joinCircle()
          : request.action === "contribute"
            ? program.methods.contribute()
            : program.methods.claimCollateral();
      transaction.add(
        await method
          .accountsPartial({
            member: owner,
            circle,
            vault,
            memberAta: ownerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      );
      break;
    }
    case "settle-round": {
      const circle = requirePublicKey(request.circle, "Circle");
      const circleAccount = await program.account.circle.fetch(circle);
      const recipient = circleAccount.members[circleAccount.round]?.key;
      if (!recipient) throw new Error("The current ajo round has no recipient.");
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("circle_vault"), circle.toBuffer()],
        program.programId,
      );
      const recipientAta = getAssociatedTokenAddressSync(mint, recipient);
      if (
        !recipientAta.equals(ownerAta) &&
        !(await connection.getAccountInfo(recipientAta, "confirmed"))
      ) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            owner,
            recipientAta,
            recipient,
            mint,
          ),
        );
      }
      transaction.add(
        await program.methods
          .settleRound()
          .accountsPartial({
            caller: owner,
            circle,
            vault,
            recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      );
      break;
    }
    case "create-event": {
      const title = request.title.trim();
      const eventDate = new Date(request.eventDate);
      const capacity = Number(request.capacity);
      if (!title || new TextEncoder().encode(title).length > 64) {
        throw new Error("Event title must be between 1 and 64 UTF-8 bytes.");
      }
      if (!Number.isFinite(eventDate.getTime()) || eventDate.getTime() <= Date.now()) {
        throw new Error("Choose an event date and time in the future.");
      }
      if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
        throw new Error("Event capacity must be between 1 and 1,000,000 tickets.");
      }

      const id = newId();
      const [event] = PublicKey.findProgramAddressSync(
        [Buffer.from("event"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
        program.programId,
      );
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("event_vault"), event.toBuffer()],
        program.programId,
      );
      transaction.add(
        await program.methods
          .createEvent(
            id,
            title,
            new BN(Math.floor(eventDate.getTime() / 1_000)),
            amountToBaseUnits(request.ticketPrice, mintInfo.decimals),
            capacity,
          )
          .accountsPartial({
            organizer: owner,
            mint,
            event,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
      break;
    }
    case "buy-ticket": {
      const event = requirePublicKey(request.event, "Event");
      const eventAccount = await program.account.event.fetch(event);
      const ticketId = eventAccount.soldCount;
      const saleId = eventAccount.nextSaleId;
      const [ticket] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("ticket"),
          event.toBuffer(),
          new BN(ticketId).toArrayLike(Buffer, "le", 4),
        ],
        program.programId,
      );
      const [sale] = PublicKey.findProgramAddressSync(
        [Buffer.from("ticket_sale"), event.toBuffer(), saleId.toArrayLike(Buffer, "le", 8)],
        program.programId,
      );
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("event_vault"), event.toBuffer()],
        program.programId,
      );
      transaction.add(
        await program.methods
          .buyTicket(ticketId, saleId)
          .accountsPartial({
            buyer: owner,
            event,
            ticket,
            sale,
            vault,
            buyerAta: ownerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
      break;
    }
    case "list-ticket":
    case "unlist-ticket": {
      const ticket = requirePublicKey(request.ticket, "Ticket");
      const ticketAccount = await program.account.ticket.fetch(ticket);
      const method =
        request.action === "list-ticket"
          ? program.methods.listTicket(
              amountToBaseUnits(request.askingPrice, mintInfo.decimals),
            )
          : program.methods.unlistTicket();
      transaction.add(
        await method
          .accountsPartial({
            owner,
            event: ticketAccount.event,
            ticket,
          })
          .instruction(),
      );
      break;
    }
    case "buy-resale": {
      const ticket = requirePublicKey(request.ticket, "Ticket");
      const ticketAccount = await program.account.ticket.fetch(ticket);
      const event = await program.account.event.fetch(ticketAccount.event);
      const eventAddress = ticketAccount.event;
      const saleId = event.nextSaleId;
      const [sale] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("ticket_sale"),
          eventAddress.toBuffer(),
          saleId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("event_vault"), eventAddress.toBuffer()],
        program.programId,
      );
      transaction.add(
        await program.methods
          .buyResale(saleId)
          .accountsPartial({
            buyer: owner,
            event: eventAddress,
            ticket,
            sale,
            vault,
            buyerAta: ownerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
      break;
    }
    case "cancel-event": {
      const event = requirePublicKey(request.event, "Event");
      transaction.add(
        await program.methods
          .cancelEvent()
          .accountsPartial({ organizer: owner, event })
          .instruction(),
      );
      break;
    }
    case "complete-event": {
      const event = requirePublicKey(request.event, "Event");
      transaction.add(
        await program.methods
          .completeEvent()
          .accountsPartial({ caller: owner, event })
          .instruction(),
      );
      break;
    }
    case "refund-ticket-sale":
    case "settle-ticket-sale": {
      const sale = requirePublicKey(request.sale, "Ticket sale");
      const saleAccount = await program.account.ticketSale.fetch(sale);
      const event = saleAccount.event;
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("event_vault"), event.toBuffer()],
        program.programId,
      );
      if (request.action === "refund-ticket-sale") {
        if (!saleAccount.buyer.equals(owner)) {
          throw new Error("Only the ticket buyer can claim this cancellation refund.");
        }
        transaction.add(
          await program.methods
            .refundTicketSale()
            .accountsPartial({
              event,
              sale,
              vault,
              buyer: owner,
              buyerAta: ownerAta,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        );
      } else {
        if (!saleAccount.seller.equals(owner)) {
          throw new Error("Only the ticket seller can claim this event payout.");
        }
        transaction.add(
          await program.methods
            .settleTicketSale()
            .accountsPartial({
              event,
              sale,
              vault,
              seller: owner,
              sellerAta: ownerAta,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        );
      }
      break;
    }
  }

  return new AnchorProvider(connection, signer, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  }).sendAndConfirm(transaction, [], { commitment: "confirmed" });
}

function makeProgramWallet(client: PollarClient, owner: PublicKey) {
  return {
    publicKey: owner,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      transaction: T,
    ): Promise<T> {
      const serialized =
        transaction instanceof Transaction
          ? transaction.serialize({
              requireAllSignatures: false,
              verifySignatures: false,
            })
          : transaction.serialize();
      const signed = fromBase64(
        await client.signSolanaTransaction(toBase64(serialized)),
      );
      return (
        transaction instanceof Transaction
          ? Transaction.from(signed)
          : VersionedTransaction.deserialize(signed)
      ) as T;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      transactions: T[],
    ): Promise<T[]> {
      return Promise.all(
        transactions.map((transaction) => this.signTransaction(transaction)),
      );
    },
  };
}
