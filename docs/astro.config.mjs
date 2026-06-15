import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.aurral.org",
  integrations: [
    starlight({
      title: "Aurral",
      description:
        "Documentation for Aurral — self-hosted music discovery for the Lidarr stack.",
      logo: {
        alt: "Aurral",
        src: "./src/assets/logo.svg",
      },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
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
      head: [
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.googleapis.com",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700;9..40,800&family=JetBrains+Mono:wght@400;500;600&display=swap",
          },
        },
      ],
      components: {
        ThemeSelect: "./src/components/Hidden.astro",
      },
      sidebar: [
        {
          label: "aurral.org",
          link: "https://aurral.org",
          attrs: { target: "_blank" },
        },
        {
          label: "Guides",
          items: [{ slug: "guides/self-hosting" }],
        },
        {
          label: "Getting started",
          items: [
            { slug: "index" },
            { slug: "getting-started/docker" },
            { slug: "getting-started/storage" },
            { slug: "getting-started/first-run" },
            { slug: "getting-started/macos-app" },
          ],
        },
        {
          label: "Using Aurral",
          items: [
            { slug: "using/overview" },
            { slug: "using/discover" },
            { slug: "using/library" },
            { slug: "using/playlists" },
            { slug: "using/flows" },
            { slug: "using/playlist-imports" },
            { slug: "using/history" },
          ],
        },
        {
          label: "Integrations",
          items: [
            { slug: "integrations/lidarr" },
            { slug: "integrations/lastfm" },
            { slug: "integrations/koito" },
            { slug: "integrations/slskd" },
            { slug: "integrations/navidrome" },
            { slug: "integrations/plex" },
            { slug: "integrations/ticketmaster" },
            { slug: "integrations/metadata" },
          ],
        },
        {
          label: "Administration",
          items: [
            { slug: "admin/storage" },
            { slug: "admin/users" },
            { slug: "admin/environment" },
            { slug: "admin/troubleshooting" },
          ],
        },
      ],
    }),
  ],
});
