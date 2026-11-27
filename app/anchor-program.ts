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

export type ProgramSnapshot = {
  configured: boolean;
  deployed: boolean;
  walletAddress: string | null;
  walletCustody: string | null;
  mint: string | null;
  decimals: number | null;
  goals: GoalSnapshot[];
  circles: CircleSnapshot[];
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
  | { action: "claim-collateral"; circle: string };

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
  const value = process.env.NEXT_PUBLIC_SOLAWISE_MINT;
  if (!value) {
    throw new Error(
      "Set NEXT_PUBLIC_SOLAWISE_MINT to the SPL token mint used by SolaWise on devnet.",
    );
  }
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
    message: null,
  };

  if (!client || !walletAddress) {
    return { ...empty, message: "Sign in with Pollar to load your devnet accounts." };
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

    const [goals, allCircles] = await Promise.all([
      program.account.goal.all(),
      program.account.circle.all(),
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

    return {
      ...empty,
      configured: true,
      deployed: true,
      mint: mint.toBase58(),
      decimals: mintInfo.decimals,
      goals: ownerGoals,
      circles: ownerCircles,
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
  walletCustody: string | null,
  request: ProgramAction,
): Promise<string> {
  if (walletCustody !== "external") {
    throw new Error(
      "Custom Anchor transactions need an external Solana wallet. Sign out, then use Pollar wallet login with Phantom, Solflare, or Backpack.",
    );
  }
  if (!process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY?.startsWith("pub_testnet_")) {
    throw new Error("SolaWise program actions are restricted to Pollar Test mode.");
  }

  const owner = requirePublicKey(walletAddress, "Pollar wallet");
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
  }

  return new AnchorProvider(connection, makeProgramWallet(client, owner), {
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
