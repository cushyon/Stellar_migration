"use client";

import { twMerge } from "tailwind-merge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { LogOut } from "lucide-react";
import useStellarWalletStore from "@/stores/useStellarWalletStore";

function abbreviateStellarAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * SSR-safe: the kit is only loaded via dynamic import() inside event handlers,
 * so this component never triggers module evaluation on the server.
 */
export default function StellarConnectButton({
  className,
}: {
  className?: string;
}) {
  const address = useStellarWalletStore((s) => s.address);
  const connected = useStellarWalletStore((s) => s.connected);

  const handleConnect = async () => {
    if (connected) return;
    try {
      const { StellarWalletsKit } = await import(
        "@creit-tech/stellar-wallets-kit"
      );
      await StellarWalletsKit.authModal();
    } catch {
      // user closed modal or error
    }
  };

  const handleDisconnect = async () => {
    const { StellarWalletsKit } = await import(
      "@creit-tech/stellar-wallets-kit"
    );
    await StellarWalletsKit.disconnect();
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className={twMerge(
            "flex items-center gap-2 text-white rounded-full bg-[linear-gradient(90deg,#091BCD_0%,#123FFC_35%,#0B3FE8_64%,#4571F4_100%)]",
            className
          )}
          onClick={handleConnect}
        >
          {!connected && <span>Connect</span>}
          {connected && address && (
            <span>{abbreviateStellarAddress(address)}</span>
          )}
        </Button>
      </PopoverTrigger>
      {connected && address && (
        <PopoverContent className="mr-2 w-40">
          <div className="flex flex-row gap-2 justify-between items-center">
            <div className="flex-1">
              {abbreviateStellarAddress(address)}
            </div>
            <button
              onClick={handleDisconnect}
              className="p-1 rounded transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
