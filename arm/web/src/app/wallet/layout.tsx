import type { Viewport } from "next";
import WalletShell from "./shell";

/** iOS WebViews zoom in when an input under 16px gets focus (the search boxes); the wallet is a fixed app layout. */
export const viewport: Viewport = {
  themeColor: "#f4f4f4",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function WalletLayout({ children }: { children: React.ReactNode }) {
  return <WalletShell>{children}</WalletShell>;
}
