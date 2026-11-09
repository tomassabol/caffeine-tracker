import { Geist_Mono } from "next/font/google";
import { CaffeineCurve } from "./caffeine-curve";

const mono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"] });

export default function Home() {
  return (
    <main className={mono.className}>
      <CaffeineCurve font={`${mono.style.fontFamily}, ui-monospace, Menlo, monospace`} />
    </main>
  );
}
