/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@mano/accounts"],
  async redirects() {
    return [{ source: "/try/:path*", destination: "/#get-mano", permanent: false }];
  },
};
export default nextConfig;
