import type { NextConfig } from "next";

/* =========================================================================
   GitHub Pages build config — used ONLY to produce the static site zip.
   Procedure:
     1. cp next.config.gh-pages.ts next.config.ts
     2. temporarily move src/app/api out of the app directory
        (API routes are not supported with static export)
     3. bunx next build            → static site is written to .next-export/
     4. zip the contents of .next-export/ and upload to the Agrima repo
     5. restore the original next.config.ts and src/app/api
   ========================================================================= */
const nextConfig: NextConfig = {
  output: "export",
  basePath: "/Agrima", // matches https://anamiir2-collab.github.io/Agrima/
  trailingSlash: true,
  images: { unoptimized: true },
  distDir: ".next-export",
  env: {
    NEXT_PUBLIC_BASE_PATH: "/Agrima",
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
