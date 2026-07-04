import Link from "next/link";
import { SiX, SiTelegram } from "react-icons/si";
import Image from "next/image";

export function Footer() {
  return (
    <footer className="w-full bg-[#123FFC] text-white py-[2.4rem] px-4 md:px-6 lg:px-8">
      <div className="container mx-auto max-w-7xl">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-y-12 md:gap-0">
          <div className="md:col-span-6 flex flex-col gap-0">
            {/* 1️⃣ Logo - pull it left only (no translate-y) */}
            <Image
              src="/logo_white.svg"
              alt="Logo"
              width={224}
              height={224}
              unoptimized
              className="-ml-11 translate-x-3 -translate-y-4"
            />

            {/* 2️⃣ Community block sits immediately below */}
            <div className="flex flex-col gap-3">
              <p className="text-lg leading-tight">Join the community</p>
              <div className="flex gap-4">
                <Link
                  href="https://x.com/cushiondottrade"
                  className="inline-block"
                >
                  <SiX className="w-6 h-6" />
                </Link>
                <Link
                  href="https://t.me/+M9BB2XVbr0xhZDVk"
                  className="inline-block"
                >
                  <SiTelegram className="w-6 h-6" />
                </Link>
              </div>
            </div>
          </div>
          <div className="md:col-span-3">
            <h3 className="text-xl font-medium mb-6">Resources</h3>
            <ul className="space-y-4">
              <li>
                <Link
                  href="https://cushion-1.gitbook.io/cushion"
                  className="hover:underline"
                >
                  Documentation
                </Link>
              </li>
              <li>
                <Link
                  href="https://github.com/cushyon"
                  className="hover:underline"
                >
                  Github
                </Link>
              </li>
              {/* <li>
                <Link href="#" className="hover:underline">
                  Media Kit
                </Link>
              </li> */}
            </ul>
          </div>
          <div className="md:col-span-3">
            <h3 className="text-xl font-medium mb-6">Company</h3>
            <ul className="space-y-4">
              <li>
                <Link
                  href="https://t.me/+M9BB2XVbr0xhZDVk"
                  className="hover:underline"
                >
                  Contact us
                </Link>
              </li>
              {/* <li>
                <Link href="#" className="hover:underline">
                  Term of use
                </Link>
              </li>
              <li>
                <Link href="#" className="hover:underline">
                  Privacy policy
                </Link>
              </li> */}
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
}
