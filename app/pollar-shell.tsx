"use client";

import {
  PollarProvider,
  usePollar,
} from "@pollar/react";
import { solanaWalletStandardAdapters } from "@pollar/solana-wallet-standard-adapter";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getProgramSnapshot,
  parseProgramAction,
  runProgramAction,
} from "./anchor-program";

function SolawiseFrame({
  onLoad,
  frameRef,
}: {
  onLoad?: () => void;
  frameRef?: React.RefObject<HTMLIFrameElement | null>;
}) {
  return (
    <iframe
      ref={frameRef}
      src="/solawise.html"
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
    login,
    logout,
    createWallet,
    openLoginModal,
    openSendModal,
    openReceiveModal,
    openRampModal,
    openTxHistoryModal,
    openWalletBalanceModal,
    refreshWalletBalance,
  } = usePollar();
  const solanaWallet = wallets.find((wallet) => wallet.chain === "SOLANA");
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
    solanaWallet?.address,
    solanaWallet?.custody,
    verified,
    walletBalance.step,
  ]);

  useEffect(() => {
    if (!frameLoaded) return;
    let active = true;
    void getProgramSnapshot(
      isAuthenticated && verified ? getClient() : null,
      solanaWallet?.address ?? null,
      solanaWallet?.custody ?? null,
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
    solanaWallet?.address,
    solanaWallet?.custody,
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
          openLoginModal();
          respond({
            type: "solawise:program-error",
            message: "Sign in with Pollar before using SolaWise accounts.",
          });
          return;
        }

        if (message.action === "refresh") {
          void getProgramSnapshot(
            getClient(),
            solanaWallet?.address ?? null,
            solanaWallet?.custody ?? null,
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
        if (!solanaWallet?.address) {
          respond({
            type: "solawise:program-error",
            message: "Connect a Solana wallet through Pollar first.",
          });
          return;
        }

        void runProgramAction(
          getClient(),
          solanaWallet.address,
          solanaWallet.custody,
          request,
        )
          .then(async (signature) => {
            respond({ type: "solawise:program-result", signature });
            const snapshot = await getProgramSnapshot(
              getClient(),
              solanaWallet.address,
              solanaWallet.custody,
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

      if (message.type === "solawise:pollar-logout") {
        logout();
        return;
      }
      if (message.type === "solawise:pollar-action") {
        if (!isAuthenticated || !verified) {
          openLoginModal();
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
        if (message.provider === "google" || message.provider === "github") {
          login({ provider: message.provider });
        } else if (
          message.provider === "email" &&
          typeof message.email === "string"
        ) {
          login({ provider: "email", email: message.email });
        } else {
          openLoginModal();
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
    frameRef,
    getClient,
    isAuthenticated,
    login,
    logout,
    openLoginModal,
    openReceiveModal,
    openRampModal,
    openSendModal,
    openTxHistoryModal,
    openWalletBalanceModal,
    refreshWalletBalance,
    solanaWallet,
    verified,
  ]);

  return null;
}

function ConfiguredPollarShell({
  apiKey,
  frameRef,
  frameLoaded,
  onFrameLoad,
}: {
  apiKey: string;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  frameLoaded: boolean;
  onFrameLoad: () => void;
}) {
  const client = useMemo(
    () => ({
      apiKey,
      walletAdapters: solanaWalletStandardAdapters(),
    }),
    [apiKey],
  );

  return (
    <PollarProvider client={client}>
      <PollarBridge frameRef={frameRef} frameLoaded={frameLoaded} />
      <SolawiseFrame frameRef={frameRef} onLoad={onFrameLoad} />
    </PollarProvider>
  );
}

export default function PollarShell() {
  const [mounted, setMounted] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const apiKey = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY;

  useEffect(() => setMounted(true), []);

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
      onFrameLoad={() => setFrameLoaded(true)}
    />
  );
}
