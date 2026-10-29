/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@mano/meter"],
  webpack: (config) => {
    // Workspace TS uses extensioned relative imports (./record.js for
    // record.ts); let webpack fall back to the TS source files.
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
export default nextConfig;
