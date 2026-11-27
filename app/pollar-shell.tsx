"use client";

import {
  PollarProvider,
  usePollar,
} from "@pollar/react";
import type { AuthState } from "@pollar/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  getProgramSnapshot,
  parseProgramAction,
  runProgramAction,
} from "./anchor-program";
import type { SolanaTransactionSigner } from "./anchor-program";

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey: PublicKey | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  on(event: "accountChanged", callback: (publicKey: PublicKey | null) => void): void;
  on(event: "disconnect", callback: () => void): void;
  off?(event: "accountChanged", callback: (publicKey: PublicKey | null) => void): void;
  off?(event: "disconnect", callback: () => void): void;
};

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
  }
}

type PollarClientConfig = {
  apiKey: string;
};

function makePhantomSigner(
  provider: PhantomProvider,
  publicKey: PublicKey,
): SolanaTransactionSigner {
  return {
    publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      transaction: T,
    ): Promise<T> {
      return provider.signTransaction(transaction);
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      transactions: T[],
    ): Promise<T[]> {
      return provider.signAllTransactions(transactions);
    },
  };
}

const clientConfigs = new Map<string, PollarClientConfig>();

function getClientConfig(apiKey: string): PollarClientConfig {
  let config = clientConfigs.get(apiKey);
  if (!config) {
    config = { apiKey };
    clientConfigs.set(apiKey, config);
  }
  return config;
}

function SolawiseFrame({
  onLoad,
  frameRef,
  initialHash = "",
}: {
  onLoad?: () => void;
  frameRef?: React.RefObject<HTMLIFrameElement | null>;
  initialHash?: string;
}) {
  return (
    <iframe
      ref={frameRef}
      src={`/solawise.html${initialHash}`}
      title="SolaWise"
      onLoad={onLoad}
      style={{ width: "100%", height: "100dvh", border: 0, display: "block" }}
    />
  );
}

function PollarBridge({
  frameRef,
  frameLoaded,
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  frameLoaded: boolean;
}) {
  const {
    isAuthenticated,
    verified,
    hasWallet,
    wallets,
    getClient,
    walletBalance,
    configStatus,
    appConfig,
    login,
    logout,
    createWallet,
    openSendModal,
    openReceiveModal,
    openRampModal,
    openTxHistoryModal,
    openWalletBalanceModal,
    refreshWalletBalance,
  } = usePollar();
  const solanaWallet = wallets.find((wallet) => wallet.chain === "SOLANA");
  const [phantomAddress, setPhantomAddress] = useState<string | null>(null);
  const phantomProvider = useRef<PhantomProvider | null>(null);
  const walletCreationStarted = useRef(false);
  const balances = useMemo(
    () =>
      walletBalance.step === "loaded"
        ? walletBalance.data.balances.map((balance) => ({
            chain: balance.chain ?? null,
            code: balance.code,
            balance: balance.balance,
            decimals: balance.decimals ?? null,
          }))
        : [],
    [walletBalance],
  );

  useEffect(() => {
    const provider = window.phantom?.solana;
    if (!provider?.isPhantom) return;
    phantomProvider.current = provider;
    setPhantomAddress(provider.publicKey?.toBase58() ?? null);

    const onAccountChanged = (publicKey: PublicKey | null) => {
      setPhantomAddress(publicKey?.toBase58() ?? null);
    };
    const onDisconnect = () => setPhantomAddress(null);
    provider.on("accountChanged", onAccountChanged);
    provider.on("disconnect", onDisconnect);

    return () => {
      provider.off?.("accountChanged", onAccountChanged);
      provider.off?.("disconnect", onDisconnect);
      phantomProvider.current = null;
    };
  }, []);

  useEffect(() => {
    const frame = frameRef.current?.contentWindow;
    if (!frame || !frameLoaded) return;

    frame.postMessage(
      {
        type: "solawise:pollar-state",
        isAuthenticated,
        verified,
        hasWallet,
        walletAddress: solanaWallet?.address ?? null,
        walletCustody: solanaWallet?.custody ?? null,
        externalWalletAddress: phantomAddress,
        balanceState: walletBalance.step,
        balances,
      },
      window.location.origin,
    );
  }, [
    balances,
    frameLoaded,
    frameRef,
    hasWallet,
    isAuthenticated,
    phantomAddress,
    solanaWallet?.address,
    solanaWallet?.custody,
    verified,
    walletBalance.step,
  ]);

  useEffect(() => {
    if (!frameLoaded) return;
    frameRef.current?.contentWindow?.postMessage(
      {
        type: "solawise:pollar-config",
        status: configStatus,
        message:
          configStatus === "error"
            ? "Pollar could not load this app’s settings. Add this site’s origin to the allowed origins in the Pollar dashboard, then reload."
            : null,
      },
      window.location.origin,
    );
  }, [configStatus, frameLoaded, frameRef]);

  useEffect(() => {
    if (!isAuthenticated) {
      walletCreationStarted.current = false;
      return;
    }

    const application = appConfig.application;
    if (
      !verified ||
      hasWallet ||
      configStatus !== "ready" ||
      application?.walletProvisioning !== "ON_DEMAND" ||
      application.walletCustodyMode === "USER_CHOICE" ||
      walletCreationStarted.current
    ) {
      return;
    }

    walletCreationStarted.current = true;
    void createWallet().catch((error: unknown) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame) return;
      frame.postMessage(
        {
          type: "solawise:pollar-error",
          message:
            error instanceof Error
              ? error.message
              : "Could not create the Pollar Solana wallet.",
        },
        window.location.origin,
      );
    });
  }, [
    appConfig.application,
    configStatus,
    createWallet,
    frameRef,
    hasWallet,
    isAuthenticated,
    verified,
  ]);

  useEffect(() => {
    if (!frameLoaded) return;
    const client = getClient();
    const publishAuthState = (state: AuthState) => {
      frameRef.current?.contentWindow?.postMessage(
        {
          type: "solawise:pollar-auth-state",
          step: state.step,
          email: "email" in state ? state.email : null,
          message: state.step === "error" ? state.message : null,
          previousStep: state.step === "error" ? state.previousStep : null,
        },
        window.location.origin,
      );
    };

    publishAuthState(client.getAuthState());
    return client.onAuthStateChange(publishAuthState);
  }, [frameLoaded, frameRef, getClient]);

  useEffect(() => {
    if (!frameLoaded) return;
    let active = true;
    void getProgramSnapshot(
      isAuthenticated && verified ? getClient() : null,
      phantomAddress,
      phantomAddress ? "external" : null,
    ).then((snapshot) => {
      if (!active) return;
      frameRef.current?.contentWindow?.postMessage(
        { type: "solawise:program-state", snapshot },
        window.location.origin,
      );
    });

    return () => {
      active = false;
    };
  }, [
    frameLoaded,
    frameRef,
    getClient,
    isAuthenticated,
    phantomAddress,
    verified,
  ]);

  useEffect(() => {
    if (!isAuthenticated || !verified || !hasWallet) return;

    void refreshWalletBalance().catch((error: unknown) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame) return;
      frame.postMessage(
        {
          type: "solawise:pollar-error",
          message:
            error instanceof Error
              ? error.message
              : "Could not refresh the Pollar wallet balance.",
        },
        window.location.origin,
      );
    });
  }, [frameRef, hasWallet, isAuthenticated, refreshWalletBalance, verified]);

  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>) {
      if (
        event.origin !== window.location.origin ||
        event.source !== frameRef.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object"
      ) {
        return;
      }

      const message = event.data as Record<string, unknown>;
      const requireLogin = () => {
        frameRef.current?.contentWindow?.postMessage(
          { type: "solawise:pollar-require-login" },
          window.location.origin,
        );
      };

      if (message.type === "solawise:phantom-connect") {
        const provider = window.phantom?.solana;
        if (!provider?.isPhantom) {
          frameRef.current?.contentWindow?.postMessage(
            {
              type: "solawise:wallet-error",
              message: "Install and unlock Phantom, then reload this page.",
            },
            window.location.origin,
          );
          return;
        }
        phantomProvider.current = provider;
        void provider
          .connect()
          .then(({ publicKey }) => setPhantomAddress(publicKey.toBase58()))
          .catch((error: unknown) => {
            frameRef.current?.contentWindow?.postMessage(
              {
                type: "solawise:wallet-error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Phantom could not connect.",
              },
              window.location.origin,
            );
          });
        return;
      }
      if (message.type === "solawise:phantom-disconnect") {
        void phantomProvider.current?.disconnect().catch((error: unknown) => {
          frameRef.current?.contentWindow?.postMessage(
            {
              type: "solawise:wallet-error",
              message:
                error instanceof Error
                  ? error.message
                  : "Phantom could not disconnect.",
            },
            window.location.origin,
          );
        });
        return;
      }
      if (message.type === "solawise:program-request") {
        const requestId = message.requestId;
        if (typeof requestId !== "string") return;
        const respond = (data: Record<string, unknown>) => {
          frameRef.current?.contentWindow?.postMessage(
            { ...data, requestId },
            window.location.origin,
          );
        };

        if (!isAuthenticated || !verified) {
          requireLogin();
          respond({
            type: "solawise:program-error",
            message: "Sign in before using SolaWise accounts.",
          });
          return;
        }

        if (message.action === "refresh") {
          void getProgramSnapshot(
            getClient(),
            phantomAddress,
            phantomAddress ? "external" : null,
          )
            .then((snapshot) =>
              respond({ type: "solawise:program-state", snapshot }),
            )
            .catch((error: unknown) =>
              respond({
                type: "solawise:program-error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Could not load SolaWise devnet accounts.",
              }),
            );
          return;
        }

        const request = parseProgramAction(message);
        if (!request) {
          respond({
            type: "solawise:program-error",
            message: "The SolaWise account action is invalid.",
          });
          return;
        }
        const provider = phantomProvider.current;
        const publicKey = provider?.publicKey;
        if (
          !phantomAddress ||
          !provider ||
          !publicKey ||
          publicKey.toBase58() !== phantomAddress
        ) {
          respond({
            type: "solawise:program-error",
            message: "Connect Phantom to sign this Solana devnet transaction.",
          });
          return;
        }

        void runProgramAction(
          getClient(),
          phantomAddress,
          request,
          makePhantomSigner(provider, publicKey),
        )
          .then(async (signature) => {
            respond({ type: "solawise:program-result", signature });
            const snapshot = await getProgramSnapshot(
              getClient(),
              phantomAddress,
              "external",
            );
            respond({ type: "solawise:program-state", snapshot });
          })
          .catch((error: unknown) =>
            respond({
              type: "solawise:program-error",
              message:
                error instanceof Error
                  ? error.message
                  : "The SolaWise devnet transaction failed.",
            }),
          );
        return;
      }
      if (message.type === "solawise:pollar-verify-email-code") {
        if (typeof message.code !== "string") return;
        try {
          getClient().verifyEmailCode(message.code);
        } catch (error) {
          const detail =
            error instanceof Error ? error.message : "Could not verify the email code.";
          frameRef.current?.contentWindow?.postMessage(
            { type: "solawise:pollar-error", message: detail },
            window.location.origin,
          );
        }
        return;
      }
      if (message.type === "solawise:pollar-logout") {
        logout();
        return;
      }
      if (message.type === "solawise:pollar-action") {
        if (!isAuthenticated || !verified) {
          requireLogin();
          return;
        }

        try {
          switch (message.action) {
            case "create-wallet":
              void createWallet().catch((error: unknown) => {
                const detail =
                  error instanceof Error
                    ? error.message
                    : "Could not create the Pollar wallet.";
                frameRef.current?.contentWindow?.postMessage(
                  { type: "solawise:pollar-error", message: detail },
                  window.location.origin,
                );
              });
              break;
            case "send":
              openSendModal();
              break;
            case "receive":
              openReceiveModal();
              break;
            case "ramp":
              openRampModal();
              break;
            case "balances":
              openWalletBalanceModal();
              break;
            case "history":
              openTxHistoryModal();
              break;
            case "refresh":
              void refreshWalletBalance().catch((error: unknown) => {
                const detail =
                  error instanceof Error
                    ? error.message
                    : "Could not refresh the Pollar wallet balance.";
                frameRef.current?.contentWindow?.postMessage(
                  { type: "solawise:pollar-error", message: detail },
                  window.location.origin,
                );
              });
              break;
            default:
              return;
          }
        } catch (error) {
          const detail =
            error instanceof Error
              ? error.message
              : "The Pollar payment action could not be opened.";
          frameRef.current?.contentWindow?.postMessage(
            { type: "solawise:pollar-error", message: detail },
            window.location.origin,
          );
        }
        return;
      }
      if (message.type !== "solawise:pollar-login") return;

      try {
        if (
          message.provider === "email" &&
          typeof message.email === "string"
        ) {
          login({ provider: "email", email: message.email });
        } else {
          frameRef.current?.contentWindow?.postMessage(
            {
              type: "solawise:pollar-error",
              message: "Use Pollar email-code sign-in.",
            },
            window.location.origin,
          );
        }
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Pollar sign-in failed.";
        frameRef.current?.contentWindow?.postMessage(
          { type: "solawise:pollar-error", message: detail },
          window.location.origin,
        );
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    createWallet,
    appConfig,
    configStatus,
    frameRef,
    getClient,
    isAuthenticated,
    login,
    logout,
    openReceiveModal,
    openRampModal,
    openSendModal,
    openTxHistoryModal,
    openWalletBalanceModal,
    refreshWalletBalance,
    phantomAddress,
    verified,
  ]);

  return null;
}

function ConfiguredPollarShell({
  apiKey,
  frameRef,
  frameLoaded,
  onFrameLoad,
  initialHash,
}: {
  apiKey: string;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  frameLoaded: boolean;
  onFrameLoad: () => void;
  initialHash: string;
}) {
  const client = getClientConfig(apiKey);

  return (
    <PollarProvider client={client}>
      <PollarBridge frameRef={frameRef} frameLoaded={frameLoaded} />
    <SolawiseFrame
      frameRef={frameRef}
      onLoad={onFrameLoad}
      initialHash={initialHash}
    />
    </PollarProvider>
  );
}

export default function PollarShell() {
  const [mounted, setMounted] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [initialHash, setInitialHash] = useState("");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const apiKey = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY;

  useEffect(() => {
    setMounted(true);
    setInitialHash(window.location.hash);
  }, []);

  if (!mounted) return <SolawiseFrame />;
  if (
    !apiKey ||
    (!apiKey.startsWith("pub_testnet_") &&
      !apiKey.startsWith("pub_mainnet_"))
  ) {
    return (
      <>
        <SolawiseFrame
          frameRef={frameRef}
          onLoad={() => setFrameLoaded(true)}
          initialHash={initialHash}
        />
        <div className="pollar-config-notice" role="status">
          Set NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY to a Pollar pub_testnet_ key
          (or pub_mainnet_ for Live) in .env.local, then restart the dev server.
        </div>
      </>
    );
  }

  return (
    <ConfiguredPollarShell
      apiKey={apiKey}
      frameRef={frameRef}
      frameLoaded={frameLoaded}
      initialHash={initialHash}
      onFrameLoad={() => setFrameLoaded(true)}
    />
  );
}
