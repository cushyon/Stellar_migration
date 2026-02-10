"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import Image from "next/image";
import { Toaster } from "react-hot-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Footer } from "@/components/Footer";

const StellarWalletProvider = dynamic(
  () => import("@/components/stellar/StellarWalletProvider"),
  { ssr: false }
);

const StellarConnectButton = dynamic(
  () => import("@/components/stellar/StellarConnectButton"),
  { ssr: false }
);

export default function StellarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <StellarWalletProvider>
      <TooltipProvider>
        <div className="flex flex-col items-center w-full flex-1">
          <div className="max-w-[1200px] w-full flex flex-col gap-4 flex-1 p-4">
            <div className="flex flex-row items-center justify-between w-full">
              <Link href="/vaults" className="flex items-center">
                <Image
                  src="/logo_white.svg"
                  width={280}
                  height={80}
                  priority
                  alt="Logo"
                  className="-translate-x-7"
                />
              </Link>
              <StellarConnectButton />
            </div>
            <main className="flex-1 flex flex-col items-center">
              <div className="w-full max-w-[1200px] p-4 flex flex-col gap-4">
                {children}
              </div>
            </main>
          </div>
        </div>
        <Footer />
        <Toaster toastOptions={{ duration: 8000 }} />
      </TooltipProvider>
    </StellarWalletProvider>
  );
}
