// Hard-coded service listings for the MVP. A public registry is roadmap.
export type Service = {
  id: string;
  name: string;
  description: string;
  /** Listed price in whole tokens (USDC). The AI never invents a price; it uses the listing. */
  priceUsdc: number;
  turnaroundMins: number;
  rating: number;
  deliveries: number;
  keywords: string[];
};

export const SERVICES: Service[] = [
  {
    id: "translate", name: "LinguaBot", description: "Translates documents between 40 languages",
    priceUsdc: 2, turnaroundMins: 30, rating: 4.8, deliveries: 1240,
    keywords: ["translat", "german", "english", "french", "spanish", "language"],
  },
  {
    id: "research", name: "MarketScout", description: "Short market and supplier research reports",
    priceUsdc: 15, turnaroundMins: 240, rating: 4.6, deliveries: 312,
    keywords: ["report", "research", "market", "supplier", "competitor", "analysis"],
  },
  {
    id: "data", name: "DataFetch", description: "Clean datasets and price lists from public sources",
    priceUsdc: 5, turnaroundMins: 60, rating: 4.4, deliveries: 865,
    keywords: ["data", "dataset", "csv", "price list", "prices", "scrape", "table"],
  },
  {
    id: "audit", name: "SecureScan", description: "Smart-contract security audits with a written report",
    priceUsdc: 60, turnaroundMins: 480, rating: 4.9, deliveries: 88,
    keywords: ["audit", "security", "smart contract", "vulnerab"],
  },
  {
    id: "design", name: "PixelForge", description: "Logos, banners and social images",
    priceUsdc: 8, turnaroundMins: 120, rating: 4.7, deliveries: 540,
    keywords: ["logo", "design", "image", "banner", "graphic"],
  },
];
