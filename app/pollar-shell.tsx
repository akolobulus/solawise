"use client";

import {
  PollarProvider,
  usePollar,
} from "@pollar/react";
import type { AuthState } from "@pollar/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  clusterApiUrl,
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
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
    solana?: PhantomProvider;
    solawiseConnectPhantom?: () => void;
  }
}

function getPhantomProvider(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const provider = window.phantom?.solana ?? window.solana;
  return provider?.isPhantom ? provider : null;
}

type PollarClientConfig = {
  apiKey: string;
};

type AuthRoute = "login" | "signup" | null;

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
  authRoute,
  setAuthRoute,
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  frameLoaded: boolean;
  authRoute: AuthRoute;
  setAuthRoute: (route: AuthRoute) => void;
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
    openLoginModal,
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
  const [phantomAvailable, setPhantomAvailable] = useState(false);
  const [phantomBalance, setPhantomBalance] = useState<{
    step: "idle" | "loading" | "loaded" | "error";
    sol: string | null;
    usdc: string | null;
  }>({ step: "idle", sol: null, usdc: null });
  const [authMessage, setAuthMessage] = useState<string | null>(null);
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
    const provider = getPhantomProvider();
    if (!provider) {
      setPhantomAvailable(false);
      return;
    }
    setPhantomAvailable(true);
    phantomProvider.current = provider;
    setPhantomAddress(provider.publicKey?.toBase58() ?? null);
    void provider
      .connect({ onlyIfTrusted: true })
      .then(({ publicKey }) => setPhantomAddress(publicKey.toBase58()))
      .catch(() => {
        // An untrusted site should remain disconnected until the user clicks Connect.
      });

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
    window.solawiseConnectPhantom = () => {
      const provider = getPhantomProvider();
      const frame = frameRef.current?.contentWindow;
      if (!provider) {
        setAuthMessage(
          "Phantom was not detected. Enable its Chrome extension, then refresh this page or use Pollar sign-in.",
        );
        frame?.postMessage(
          {
            type: "solawise:wallet-error",
            message: "Phantom was not detected. Enable its Chrome extension, then refresh this page or use Pollar sign-in.",
          },
          window.location.origin,
        );
        return;
      }

      phantomProvider.current = provider;
      setAuthMessage("Check Phantom and approve the connection request to continue.");
      frame?.postMessage(
        {
          type: "solawise:wallet-pending",
          message: "Check Phantom and approve the connection request to continue.",
        },
        window.location.origin,
      );
      void provider
        .connect()
        .then(({ publicKey }) => {
          setPhantomAddress(publicKey.toBase58());
          setAuthMessage(null);
        })
        .catch((error: unknown) => {
          const errorCode =
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : null;
          const message =
            errorCode === 4001
              ? "Connection declined. Click Connect Phantom and approve the request in your extension."
              : error instanceof Error
                ? error.message
                : "Phantom could not connect.";
          setAuthMessage(message);
          frame?.postMessage(
            { type: "solawise:wallet-error", message },
            window.location.origin,
          );
        });
    };

    return () => {
      delete window.solawiseConnectPhantom;
    };
  }, [frameRef]);

  useEffect(() => {
    if (!phantomAddress) {
      setPhantomBalance({ step: "idle", sol: null, usdc: null });
      return;
    }

    let active = true;
    setPhantomBalance((current) => ({ ...current, step: "loading" }));
    const owner = new PublicKey(phantomAddress);
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
    const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

    void Promise.all([
      connection.getBalance(owner).catch(() => null),
      getAccount(connection, ata, "confirmed").catch(() => null),
    ]).then(([lamports, usdcAccount]) => {
      if (!active) return;
      if (lamports === null && usdcAccount === null) {
        setPhantomBalance({ step: "error", sol: null, usdc: null });
        return;
      }
      setPhantomBalance({
        step: "loaded",
        sol: lamports === null ? null : (lamports / 1_000_000_000).toFixed(4),
        usdc:
          usdcAccount === null
            ? "0.000000"
            : (Number(usdcAccount.amount) / 1_000_000).toFixed(6),
      });
    });

    return () => {
      active = false;
    };
  }, [phantomAddress]);

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
        phantomAvailable,
        phantomBalance: {
          step: phantomBalance.step,
          sol: phantomBalance.sol,
          usdc: phantomBalance.usdc,
        },
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
    phantomAvailable,
    phantomBalance,
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
      if (state.step === "error") {
        setAuthMessage(state.message);
      } else if (state.step === "sending_email") {
        setAuthMessage("Pollar is sending your verification code.");
      } else if (state.step === "entering_code" || state.step === "verifying_email_code") {
        setAuthMessage("Complete the verification step in the Pollar sign-in window.");
      } else if (state.step === "authenticated" && state.verified) {
        setAuthMessage(null);
      }

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
  }, [frameLoaded, frameRef, getClient, setAuthMessage]);

  useEffect(() => {
    if (!frameLoaded) return;
    let active = true;
    void getProgramSnapshot(
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
    phantomAddress,
  ]);

  useEffect(() => {
    if (!phantomAddress && !(isAuthenticated && verified)) return;
    setAuthRoute(null);
    setAuthMessage(null);
  }, [isAuthenticated, phantomAddress, setAuthRoute, verified]);

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
      if (message.type === "solawise:auth-route") {
        const route = message.route;
        if (route === "login" || route === "signup") {
          setAuthRoute(route);
          setAuthMessage(null);
        } else if (route === null) {
          setAuthRoute(null);
          setAuthMessage(null);
        }
        return;
      }
      const requireLogin = () => {
        frameRef.current?.contentWindow?.postMessage(
          { type: "solawise:pollar-require-login" },
          window.location.origin,
        );
      };

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

        if (message.action === "refresh") {
          void getProgramSnapshot(
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
          phantomAddress,
          request,
          makePhantomSigner(provider, publicKey),
        )
          .then(async (signature) => {
            respond({ type: "solawise:program-result", signature });
            const snapshot = await getProgramSnapshot(phantomAddress, "external");
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
    setAuthRoute,
    verified,
  ]);

  if (!authRoute) return null;

  const connectWithPhantom = () => {
    if (typeof window.solawiseConnectPhantom !== "function") {
      setAuthMessage("Wallet connection is still initializing. Refresh and try again.");
      return;
    }
    window.solawiseConnectPhantom();
  };
  const connectWithPollar = () => {
    setAuthMessage(null);
    try {
      openLoginModal();
    } catch (error) {
      setAuthMessage(
        error instanceof Error ? error.message : "Pollar sign-in could not be opened.",
      );
    }
  };

  const walletConnectControl =
    authRoute === null && isAuthenticated && verified && !phantomAddress ? (
      <div
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 40,
          display: "grid",
          gap: 8,
          justifyItems: "end",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <button
          type="button"
          onClick={connectWithPhantom}
          style={{
            minHeight: 44,
            padding: "0 16px",
            border: 0,
            borderRadius: 8,
            background: "#0067F5",
            color: "#fff",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Connect Phantom for savings
        </button>
        {authMessage && (
          <span
            role="status"
            style={{
              maxWidth: 320,
              padding: "8px 12px",
              borderRadius: 8,
              background: "#fff",
              color: "#0A2E65",
            }}
          >
            {authMessage}
          </span>
        )}
      </div>
    ) : null;

  return (
    <>
      {walletConnectControl}
      {authRoute && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 40,
            display: "grid",
            placeItems: "center",
            padding: 24,
            background: "rgba(10, 20, 42, .72)",
            fontFamily: "system-ui, sans-serif",
          }}
        >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="solawise-auth-title"
          style={{
            width: "min(440px, 100%)",
            padding: 28,
            borderRadius: 20,
            background: "#fff",
            color: "#0A2E65",
            boxShadow: "0 24px 80px rgba(0,0,0,.24)",
          }}
        >
          <h1 id="solawise-auth-title" style={{ margin: "0 0 8px", fontSize: 28 }}>
            {authRoute === "signup" ? "Create your SolaWise account" : "Welcome back"}
          </h1>
          <p style={{ margin: "0 0 20px", color: "#6b7a95", lineHeight: 1.5 }}>
            Choose Phantom or Pollar. Approve the request in your wallet or complete Pollar sign-in to continue.
          </p>
          <button
            type="button"
            onClick={connectWithPhantom}
            style={{
              width: "100%",
              minHeight: 48,
              border: 0,
              borderRadius: 8,
              background: "#0067F5",
              color: "#fff",
              fontSize: 16,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Continue with Phantom
          </button>
          <button
            type="button"
            onClick={connectWithPollar}
            style={{
              width: "100%",
              minHeight: 48,
              marginTop: 10,
              border: "1px solid #d5ddec",
              borderRadius: 8,
              background: "#fff",
              color: "#0A2E65",
              fontSize: 16,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Continue with Pollar
          </button>
          {authMessage && (
            <p role="status" style={{ margin: "14px 0 0", color: "#6b7a95", lineHeight: 1.5 }}>
              {authMessage}
            </p>
          )}
        </div>
        </div>
      )}
    </>
  );
}

function ConfiguredPollarShell({
  apiKey,
  frameRef,
  frameLoaded,
  onFrameLoad,
  initialHash,
  authRoute,
  setAuthRoute,
}: {
  apiKey: string;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  frameLoaded: boolean;
  onFrameLoad: () => void;
  initialHash: string;
  authRoute: AuthRoute;
  setAuthRoute: (route: AuthRoute) => void;
}) {
  const client = getClientConfig(apiKey);

  return (
    <PollarProvider client={client}>
      <PollarBridge
        frameRef={frameRef}
        frameLoaded={frameLoaded}
        authRoute={authRoute}
        setAuthRoute={setAuthRoute}
      />
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
  const [authRoute, setAuthRoute] = useState<AuthRoute>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const apiKey = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY;

  useEffect(() => {
    setMounted(true);
    setInitialHash(window.location.hash);
    if (window.location.hash === "#login") setAuthRoute("login");
    else if (window.location.hash === "#signup") setAuthRoute("signup");
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
      authRoute={authRoute}
      setAuthRoute={setAuthRoute}
    />
  );
}
