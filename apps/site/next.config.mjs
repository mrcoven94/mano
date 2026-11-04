/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@mano/accounts", "@mano/protocol", "@mano/quality"],
};
export default nextConfig;
