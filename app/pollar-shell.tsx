"use client";

import {
  PollarProvider,
  usePollar,
} from "@pollar/react";
import type { User } from "@supabase/supabase-js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
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
import {
  getSupabaseBrowserClient,
  type LinkedAccount,
  type LinkedAccountProvider,
  type SupabaseBrowserClient,
} from "./supabase";

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey: PublicKey | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signMessage?(
    message: Uint8Array,
    display?: "utf8" | "hex",
  ): Promise<{ signature: Uint8Array; publicKey: PublicKey }>;
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
  supabase,
  supabaseUser,
  supabaseAuthReady,
  supabaseAuthError,
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  frameLoaded: boolean;
  authRoute: AuthRoute;
  setAuthRoute: (route: AuthRoute) => void;
  supabase: SupabaseBrowserClient | null;
  supabaseUser: User | null;
  supabaseAuthReady: boolean;
  supabaseAuthError: string | null;
}) {
  const {
    isAuthenticated,
    verified,
    hasWallet,
    wallets,
    walletBalance,
    configStatus,
    appConfig,
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
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const phantomProvider = useRef<PhantomProvider | null>(null);
  const walletCreationStarted = useRef(false);
  const pendingPhantomLink = useRef(false);
  const pendingPollarLink = useRef(false);
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

  const postToFrame = useCallback(
    (message: Record<string, unknown>) => {
      frameRef.current?.contentWindow?.postMessage(message, window.location.origin);
    },
    [frameRef],
  );

  const saveLinkedAccount = useCallback(
    async (
      provider: LinkedAccountProvider,
      walletAddress: string,
    ): Promise<boolean> => {
      if (!supabase || !supabaseUser) return false;
      try {
        const { error } = await supabase.from("linked_accounts").upsert(
          {
            user_id: supabaseUser.id,
            provider,
            wallet_address: walletAddress,
          },
          { onConflict: "user_id,provider" },
        );
        if (error) throw error;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "The database request failed.";
        const message = `Could not save the ${provider === "pollar" ? "Pollar" : "Phantom"} link: ${detail}`;
        setAuthMessage(message);
        postToFrame({ type: "solawise:account-link-error", message });
        return false;
      }

      setLinkedAccounts((current) => [
        ...current.filter((account) => account.provider !== provider),
        {
          user_id: supabaseUser.id,
          provider,
          wallet_address: walletAddress,
          linked_at:
            current.find((account) => account.provider === provider)?.linked_at ??
            new Date().toISOString(),
        },
      ]);
      postToFrame({ type: "solawise:account-linked", provider, walletAddress });
      setAuthMessage(null);
      return true;
    },
    [postToFrame, supabase, supabaseUser],
  );

  useEffect(() => {
    if (!supabase || !supabaseUser) {
      setLinkedAccounts([]);
      return;
    }

    let active = true;
    setLinkedAccounts([]);
    void (async () => {
      try {
        const { data, error } = await supabase
          .from("linked_accounts")
          .select("user_id,provider,wallet_address,linked_at")
          .eq("user_id", supabaseUser.id);
        if (!active) return;
        if (error) throw error;
        setLinkedAccounts(data ?? []);
      } catch (error) {
        if (!active) return;
        const detail =
          error instanceof Error ? error.message : "The database request failed.";
        const message = `Could not load your linked accounts: ${detail}`;
        setAuthMessage(message);
        postToFrame({ type: "solawise:account-link-error", message });
      }
    })();

    return () => {
      active = false;
    };
  }, [postToFrame, supabase, supabaseUser?.id]);

  useEffect(() => {
    if (!supabaseUser || !pendingPhantomLink.current || !phantomAddress) return;
    pendingPhantomLink.current = false;
    void saveLinkedAccount("phantom", phantomAddress);
  }, [phantomAddress, saveLinkedAccount, supabaseUser]);

  useEffect(() => {
    if (
      !supabaseUser ||
      !pendingPollarLink.current ||
      !isAuthenticated ||
      !verified ||
      !solanaWallet?.address
    ) {
      return;
    }
    pendingPollarLink.current = false;
    void saveLinkedAccount("pollar", solanaWallet.address);
  }, [
    isAuthenticated,
    saveLinkedAccount,
    solanaWallet?.address,
    supabaseUser,
    verified,
  ]);

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
      if (!supabaseUser) {
        setAuthMessage("Sign in with your SolaWise account before linking Phantom.");
        setAuthRoute("login");
        return;
      }

      pendingPhantomLink.current = true;
      if (phantomAddress) {
        pendingPhantomLink.current = false;
        void saveLinkedAccount("phantom", phantomAddress);
        return;
      }

      const provider = getPhantomProvider();
      const frame = frameRef.current?.contentWindow;
      if (!provider) {
        setAuthMessage(
          "Phantom was not detected. Enable its Chrome extension and refresh, or link a Pollar account for spending.",
        );
        frame?.postMessage(
          {
            type: "solawise:wallet-error",
            message: "Phantom was not detected. Enable its Chrome extension and refresh, or link a Pollar account for spending.",
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
  }, [
    frameRef,
    phantomAddress,
    saveLinkedAccount,
    setAuthRoute,
    supabaseUser,
  ]);

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
        supabaseAuthenticated: Boolean(supabaseUser),
        supabaseEmail: supabaseUser?.email ?? null,
        linkedAccounts: linkedAccounts.map(({ provider, wallet_address }) => ({
          provider,
          walletAddress: wallet_address,
        })),
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
    linkedAccounts,
    phantomAddress,
    phantomAvailable,
    phantomBalance,
    solanaWallet?.address,
    solanaWallet?.custody,
    supabaseUser,
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
    if (!supabaseUser) return;
    setAuthRoute(null);
    setAuthMessage(null);
  }, [setAuthRoute, supabaseUser]);

  useEffect(() => {
    pendingPhantomLink.current = false;
    pendingPollarLink.current = false;
  }, [supabaseUser?.id]);

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

  const requestPollarLink = useCallback(() => {
    if (!supabaseUser) {
      setAuthMessage("Sign in with your SolaWise account before linking Pollar.");
      setAuthRoute("login");
      return;
    }

    pendingPollarLink.current = true;
    if (isAuthenticated && verified) {
      if (solanaWallet?.address) {
        pendingPollarLink.current = false;
        void saveLinkedAccount("pollar", solanaWallet.address);
      } else {
        postToFrame({
          type: "solawise:pollar-error",
          message: "Pollar is connected. Create its Solana wallet before linking it for spending.",
        });
      }
      return;
    }

    setAuthMessage(null);
    try {
      openLoginModal();
    } catch (error) {
      setAuthMessage(
        error instanceof Error ? error.message : "Pollar linking could not be opened.",
      );
    }
  }, [
    isAuthenticated,
    openLoginModal,
    postToFrame,
    saveLinkedAccount,
    setAuthRoute,
    solanaWallet?.address,
    supabaseUser,
    verified,
  ]);

  const submitSupabaseAuth = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (!supabase) {
      setAuthMessage(
        "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, then restart the app.",
      );
      return;
    }

    const email = authEmail.trim().toLowerCase();
    if (!email || !authPassword) {
      setAuthMessage("Enter your email and password.");
      return;
    }

    setAuthBusy(true);
    setAuthMessage(null);
    try {
      if (authRoute === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password: authPassword,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (!data.session) {
          setAuthMessage(
            "Email confirmation is enabled in Supabase. To sign up without a verification code, disable Confirm email in Authentication > Providers > Email, then try again.",
          );
          setAuthPassword("");
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password: authPassword,
        });
        if (error) throw error;
      }
      setAuthPassword("");
      setAuthMessage(null);
    } catch (error) {
      setAuthMessage(
        error instanceof Error
          ? error.message
          : "Supabase sign-in could not be completed.",
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const signInWithPhantom = async () => {
    if (!supabase) {
      setAuthMessage(
        "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, then restart the app.",
      );
      return;
    }

    const provider = getPhantomProvider();
    if (!provider) {
      setAuthMessage("Phantom was not detected. Install or enable its browser extension.");
      return;
    }
    if (typeof provider.signMessage !== "function") {
      setAuthMessage("This Phantom connection does not support signing authentication messages.");
      return;
    }

    setAuthBusy(true);
    setAuthMessage("Approve the SolaWise sign-in message in Phantom. No verification code is needed.");
    try {
      const { publicKey } = await provider.connect();
      phantomProvider.current = provider;
      setPhantomAddress(publicKey.toBase58());
      pendingPhantomLink.current = true;
      const { error } = await supabase.auth.signInWithWeb3({
        chain: "solana",
        statement: "Sign in to SolaWise. This message does not authorize a transaction.",
        wallet: {
          publicKey,
          signMessage: async (message) => {
            const result = await provider.signMessage!(message, "utf8");
            return result.signature;
          },
        },
      });
      if (error) throw error;
      setAuthMessage(null);
      setAuthRoute(null);
    } catch (error) {
      pendingPhantomLink.current = false;
      setAuthMessage(
        error instanceof Error ? error.message : "Phantom sign-in could not be completed.",
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const signOutOfSolaWise = async () => {
    if (!supabase) return;
    setAuthBusy(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (error) {
      setAuthMessage(
        `Could not sign out: ${error instanceof Error ? error.message : "The Supabase request failed."}`,
      );
      setAuthBusy(false);
      return;
    }

    logout();
    pendingPhantomLink.current = false;
    pendingPollarLink.current = false;
    try {
      await phantomProvider.current?.disconnect();
    } catch (error) {
      postToFrame({
        type: "solawise:wallet-error",
        message:
          error instanceof Error
            ? `Signed out, but Phantom did not disconnect: ${error.message}`
            : "Signed out, but Phantom did not disconnect.",
      });
    }
    setPhantomAddress(null);
    setAuthRoute(null);
    postToFrame({ type: "solawise:auth-signed-out" });
    setAuthBusy(false);
  };

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
        setAuthMessage(null);
        setAuthRoute("login");
        frameRef.current?.contentWindow?.postMessage(
          { type: "solawise:auth-required" },
          window.location.origin,
        );
      };

      if (message.type === "solawise:app-logout") {
        void signOutOfSolaWise();
        return;
      }
      if (message.type === "solawise:pollar-link") {
        requestPollarLink();
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
        if (!supabaseUser) {
          respond({
            type: "solawise:program-error",
            message: "Sign in with your SolaWise account before making a transaction.",
          });
          requireLogin();
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
        if (
          !linkedAccounts.some(
            (account) =>
              account.provider === "phantom" &&
              account.wallet_address === phantomAddress,
          )
        ) {
          respond({
            type: "solawise:program-error",
            message: "Link this Phantom wallet to your SolaWise account before transacting.",
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
      if (message.type === "solawise:pollar-logout") {
        void signOutOfSolaWise();
        return;
      }
      if (message.type === "solawise:pollar-action") {
        if (!supabaseUser) {
          requireLogin();
          return;
        }
        if (message.action === "link") {
          requestPollarLink();
          return;
        }
        if (message.action === "create-wallet") {
          if (!isAuthenticated || !verified) {
            requestPollarLink();
            return;
          }
          void createWallet().catch((error: unknown) => {
            const detail =
              error instanceof Error ? error.message : "Could not create the Pollar wallet.";
            postToFrame({ type: "solawise:pollar-error", message: detail });
          });
          return;
        }
        const linkedPollarAddress = linkedAccounts.find(
          (account) => account.provider === "pollar",
        )?.wallet_address;
        if (
          !isAuthenticated ||
          !verified ||
          !solanaWallet?.address ||
          linkedPollarAddress !== solanaWallet.address
        ) {
          requestPollarLink();
          return;
        }

        try {
          switch (message.action) {
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
      if (message.type === "solawise:pollar-login") requestPollarLink();
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    createWallet,
    linkedAccounts,
    appConfig,
    configStatus,
    frameRef,
    isAuthenticated,
    logout,
    openReceiveModal,
    openRampModal,
    openSendModal,
    openTxHistoryModal,
    openWalletBalanceModal,
    refreshWalletBalance,
    phantomAddress,
    requestPollarLink,
    postToFrame,
    setAuthRoute,
    signOutOfSolaWise,
    solanaWallet?.address,
    supabaseUser,
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
  const walletConnectControl =
    authRoute === null &&
    supabaseUser &&
    (!phantomAddress ||
      !linkedAccounts.some(
        (account) =>
          account.provider === "phantom" &&
          account.wallet_address === phantomAddress,
      )) ? (
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
          {phantomAddress ? "Link Phantom to SolaWise" : "Connect Phantom for savings"}
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
            {authRoute === "signup"
              ? "Create an account with email and password or use Phantom. Email signup skips verification codes when Confirm email is disabled in Supabase."
              : "Sign in with your email and password or use Phantom. Phantom sign-in needs your approval for a message, not an email verification code."}
          </p>
          <form onSubmit={submitSupabaseAuth}>
            <label htmlFor="solawise-auth-email" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
              Email
            </label>
            <input
              id="solawise-auth-email"
              type="email"
              autoComplete="email"
              required
              value={authEmail}
              onChange={(event) => setAuthEmail(event.target.value)}
              style={{ width: "100%", minHeight: 46, padding: "0 12px", border: "1px solid #d5ddec", borderRadius: 8, boxSizing: "border-box" }}
            />
            <label htmlFor="solawise-auth-password" style={{ display: "block", margin: "14px 0 6px", fontWeight: 600 }}>
              Password
            </label>
            <input
              id="solawise-auth-password"
              type="password"
              autoComplete={authRoute === "signup" ? "new-password" : "current-password"}
              minLength={authRoute === "signup" ? 8 : undefined}
              required
              value={authPassword}
              onChange={(event) => setAuthPassword(event.target.value)}
              style={{ width: "100%", minHeight: 46, padding: "0 12px", border: "1px solid #d5ddec", borderRadius: 8, boxSizing: "border-box" }}
            />
            <button
              type="submit"
              disabled={!supabaseAuthReady || !supabase || authBusy}
              style={{
                width: "100%",
                minHeight: 48,
                marginTop: 18,
                border: 0,
                borderRadius: 8,
                background: "#0067F5",
                color: "#fff",
                fontSize: 16,
                fontWeight: 700,
                cursor: "pointer",
                opacity: !supabaseAuthReady || !supabase || authBusy ? 0.6 : 1,
              }}
            >
              {authBusy
                ? "Please wait…"
                : authRoute === "signup"
                  ? "Create account"
                  : "Sign in"}
            </button>
          </form>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              margin: "16px 0",
              color: "#8793a8",
              fontSize: 13,
            }}
          >
            <span style={{ height: 1, flex: 1, background: "#e5eaf2" }} />
            or
            <span style={{ height: 1, flex: 1, background: "#e5eaf2" }} />
          </div>
          <button
            type="button"
            onClick={() => void signInWithPhantom()}
            disabled={!supabaseAuthReady || !supabase || authBusy}
            style={{
              width: "100%",
              minHeight: 48,
              border: "1px solid #d5ddec",
              borderRadius: 8,
              background: "#fff",
              color: "#0A2E65",
              fontSize: 16,
              fontWeight: 700,
              cursor: "pointer",
              opacity: !supabaseAuthReady || !supabase || authBusy ? 0.6 : 1,
            }}
          >
            {authBusy ? "Please wait…" : "Continue with Phantom"}
          </button>
          <p style={{ margin: "14px 0 0", color: "#6b7a95", lineHeight: 1.5 }} role="status">
            {!supabaseAuthReady
              ? "Checking Supabase session…"
              : !supabase
                ? "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, apply the database migration, and restart the app."
                : supabaseAuthError || authMessage || ""}
          </p>
          <button
            type="button"
            onClick={() => {
              setAuthMessage(null);
              setAuthPassword("");
              setAuthRoute(authRoute === "signup" ? "login" : "signup");
            }}
            style={{ marginTop: 14, padding: 0, border: 0, background: "transparent", color: "#0067F5", fontWeight: 600, cursor: "pointer" }}
          >
            {authRoute === "signup"
              ? "Already have an account? Sign in"
              : "New to SolaWise? Create an account"}
          </button>
          <button
            type="button"
            onClick={() => setAuthRoute(null)}
            style={{ display: "block", margin: "14px auto 0", padding: 0, border: 0, background: "transparent", color: "#6b7a95", cursor: "pointer" }}
          >
            Cancel
          </button>
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
  supabase,
  supabaseUser,
  supabaseAuthReady,
  supabaseAuthError,
}: {
  apiKey: string;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  frameLoaded: boolean;
  onFrameLoad: () => void;
  initialHash: string;
  authRoute: AuthRoute;
  setAuthRoute: (route: AuthRoute) => void;
  supabase: SupabaseBrowserClient | null;
  supabaseUser: User | null;
  supabaseAuthReady: boolean;
  supabaseAuthError: string | null;
}) {
  const client = getClientConfig(apiKey);

  return (
    <PollarProvider client={client}>
      <PollarBridge
        frameRef={frameRef}
        frameLoaded={frameLoaded}
        authRoute={authRoute}
        setAuthRoute={setAuthRoute}
        supabase={supabase}
        supabaseUser={supabaseUser}
        supabaseAuthReady={supabaseAuthReady}
        supabaseAuthError={supabaseAuthError}
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
  const [supabase, setSupabase] = useState<SupabaseBrowserClient | null>(null);
  const [supabaseUser, setSupabaseUser] = useState<User | null>(null);
  const [supabaseAuthReady, setSupabaseAuthReady] = useState(false);
  const [supabaseAuthError, setSupabaseAuthError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const apiKey = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY;

  useEffect(() => {
    setMounted(true);
    setInitialHash(window.location.hash);
    if (window.location.hash === "#login") setAuthRoute("login");
    else if (window.location.hash === "#signup") setAuthRoute("signup");
  }, []);

  useEffect(() => {
    let client: SupabaseBrowserClient | null;
    try {
      client = getSupabaseBrowserClient();
    } catch (error) {
      setSupabaseAuthError(
        error instanceof Error ? error.message : "Invalid Supabase configuration.",
      );
      setSupabaseAuthReady(true);
      return;
    }
    setSupabase(client);
    if (!client) {
      setSupabaseAuthReady(true);
      return;
    }

    let active = true;
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      setSupabaseUser(session?.user ?? null);
      setSupabaseAuthReady(true);
      setSupabaseAuthError(null);
    });

    void client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setSupabaseAuthError(error.message);
          setSupabaseAuthReady(true);
          return;
        }
        setSupabaseUser(data.session?.user ?? null);
        setSupabaseAuthReady(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSupabaseAuthError(
          error instanceof Error ? error.message : "Could not restore your Supabase session.",
        );
        setSupabaseAuthReady(true);
      });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
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
      supabase={supabase}
      supabaseUser={supabaseUser}
      supabaseAuthReady={supabaseAuthReady}
      supabaseAuthError={supabaseAuthError}
    />
  );
}
