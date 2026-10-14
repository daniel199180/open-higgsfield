import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
    return {
        name: "Open-Higgsfield - AI Image & Video Studio",
        short_name: "Open-Higgsfield",
        description: "Open-source multi-provider AI image and video generation studio.",
        start_url: "/",
        display: "standalone",
        background_color: "#000000",
        theme_color: "#000000",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
    };
}
