
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
        { href: 'katex/katex.min.css', type: 'text/css' },
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
                    rehypePlugins: [rehype],
                },
                blog: false,
            },
        ],
    ],
    themes: ["@docusaurus/theme-mermaid"],
};
