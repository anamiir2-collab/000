import Script from "next/script";
import AgrimaApp from "@/components/agrima/AgrimaApp";

// Base path for GitHub Pages subpath deployment ('' in dev, '/Agrima' in the GH Pages build)
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

export default function Home() {
  return (
    <>
      <Script src={`${BASE}/vendor/xlsx.full.min.js`} strategy="beforeInteractive" />
      <AgrimaApp />
    </>
  );
}
