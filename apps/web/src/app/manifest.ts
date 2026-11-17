import type { MetadataRoute } from "next";

// Lets the web app be added to a phone's home screen and open full screen.
// Android users run Clementine this way until there is a native Android app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Clementine",
    short_name: "Clementine",
    description: "Shared costs, split by the rules you set.",
    start_url: "/",
    display: "standalone",
    background_color: "#FFF4E2",
    theme_color: "#13261F",
    icons: [
      { src: "/icons/192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
