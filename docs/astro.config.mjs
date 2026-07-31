import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.aurral.org",
  integrations: [
    starlight({
      title: "Aurral",
      description: "Documentation for Aurral: self-hosted music discovery for the Lidarr stack.",
      logo: {
        alt: "Aurral",
        src: "./src/assets/logo.svg",
      },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      expressiveCode: { themes: ["starlight-dark"] },
      editLink: {
        baseUrl: "https://github.com/lklynet/aurral/edit/main/docs/",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/lklynet/aurral",
        },
        {
          icon: "discord",
          label: "Discord",
          href: "https://discord.gg/cpPYfgVURJ",
        },
      ],
      components: {
        Head: "./src/components/Head.astro",
        ThemeSelect: "./src/components/Hidden.astro",
        ThemeProvider: "./src/components/Hidden.astro",
      },
      sidebar: [
        { label: "Aurral Docs", slug: "index" },
        {
          label: "Get started",
          collapsed: true,
          items: [
            { slug: "getting-started/docker" },
            { slug: "getting-started/storage" },
            { slug: "getting-started/first-run" },
          ],
        },
        {
          label: "Use Aurral",
          collapsed: true,
          items: [
            { slug: "using/overview" },
            { slug: "using/discover" },
            { slug: "using/library" },
            { slug: "using/playlists" },
            { slug: "using/flows" },
            { slug: "using/playlist-imports" },
            { slug: "using/activity" },
            { slug: "tools/spotify-csv-converter" },
          ],
        },
        {
          label: "Integrations",
          collapsed: true,
          items: [
            { slug: "integrations/lidarr" },
            { slug: "integrations/lastfm" },
            { slug: "integrations/koito" },
            { slug: "integrations/slskd" },
            { slug: "integrations/ytdlp" },
            { slug: "integrations/usenet" },
            { slug: "integrations/navidrome" },
            { slug: "integrations/plex" },
            { slug: "integrations/ticketmaster" },
            { slug: "integrations/metadata" },
            { slug: "integrations/notifications" },
          ],
        },
        {
          label: "Administration",
          collapsed: true,
          items: [
            { slug: "admin/storage" },
            { slug: "admin/users" },
            { slug: "admin/environment" },
            { slug: "admin/troubleshooting" },
          ],
        },
        {
          label: "API",
          collapsed: true,
          items: [
            { slug: "api/overview" },
            { slug: "api/endpoints" },
          ],
        },
        { label: "Sponsorship", slug: "sponsorship" },
      ],
    }),
  ],
});
