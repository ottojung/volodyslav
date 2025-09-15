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
    presets: [
        [
            "classic",
            {
                docs: {
                    routeBasePath: "/",
                    sidebarPath: require.resolve("./sidebars.js"),
                    path: ".",
                    remarkPlugins: [require('remark-math')],
                    rehypePlugins: [require('rehype-katex')],
                },
                blog: false,
            },
        ],
    ],
};
