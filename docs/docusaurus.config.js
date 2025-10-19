
const remark = require('remark-math').default;
const rehype = require('rehype-katex').default;

module.exports = {
    title: "Volodyslav Documentation",
    tagline: "Documentation for the Volodyslav project",
    url: "https://ottojung.github.io",
    baseUrl: "/volodyslav/",
    onBrokenLinks: "warn",
    onBrokenMarkdownLinks: "warn",
    favicon: "img/favicon.ico",
    organizationName: "volodyslav",
    projectName: "docs",
    markdown: {
        format: "md",
        mermaid: true,
    },
    stylesheets: [
        {
            href: 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css',
            type: 'text/css',
            integrity: 'sha384-5TcZemv2l/9On385z///+d7MSYlvIEw9FuZTIdZ14vJLqWphw7e7ZPuOiCHJcFCP',
            crossorigin: 'anonymous',
        },
    ],
    presets: [
        [
            "classic",
            {
                docs: {
                    routeBasePath: "/",
                    sidebarPath: require.resolve("./sidebars.js"),
                    path: ".",
                    exclude: [
                        '**/node_modules/**',
                        '**/build/**',
                    ],
                    remarkPlugins: [remark],
                    rehypePlugins: [rehype],
                },
                blog: false,
            },
        ],
    ],
    themes: ["@docusaurus/theme-mermaid"],
};
