
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
            href: 'https://cdn.jsdelivr.net/npm/katex@0.13.24/dist/katex.min.css',
            type: 'text/css',
            integrity: 'sha384-odtC9E8luH2fLNj2svR5C7L8FS25PymvSmOwpLyHsrpp9AiQ4G2IpgKtaZ0L04zv',
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
                    remarkPlugins: [remark],
                    rehypePlugins: [[rehype, { throwOnError: true, errorColor: '#cc0000' }]],
                },
                blog: false,
            },
        ],
    ],
    themes: ["@docusaurus/theme-mermaid"],
};
