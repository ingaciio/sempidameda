export type CheckStatus = "available" | "taken" | "error" | "unknown";

export type SimilarityLevel = "exact" | "contains" | "partial";

export interface MatchGroup {
  level: SimilarityLevel;
  label: string;
  matches: TrademarkMatch[];
}

export interface CheckResult {
  platform: string;
  displayName: string;
  status: CheckStatus;
  detail: string;
  url?: string;
  buyUrl?: string;
  responseTimeMs: number;
  matchGroups?: MatchGroup[];
}

export interface BrandCheckRequest {
  name: string;
  description?: string;
}

export interface BrandCheckResponse {
  name: string;
  normalizedName: string;
  description?: string;
  timestamp: string;
  results: CheckResult[];
  variations: VariationGroup[];
  summary: {
    total: number;
    available: number;
    taken: number;
    errors: number;
    unknown: number;
  };
}

export interface VariationGroup {
  platform: string;
  displayName: string;
  checks: CheckResult[];
}

// ── Trademark search engine types ─────────────────────────────────────

/** Normalized trademark match from any registry (INPI, WIPO, etc.) */
export interface TrademarkMatch {
  brandName: string;
  owner: string;
  niceClasses: number[];
  status: string;
  isActive: boolean;
  isExactMatch: boolean;
  similarityLevel: SimilarityLevel;
  sourceId: string;
  country?: string;
  ipr?: string;
}

/** Configuration for the shared trademark search engine */
export interface TrademarkSearchConfig {
  platform: string;
  displayName: string;
  searchUrl: string;
  description?: string;
  brandName: string;
  totalSimilarResults?: number;
}
