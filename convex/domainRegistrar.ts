import { ConvexError } from "convex/values";

export type DomainAvailability = {
  domain: string;
  available: boolean;
  price: number;
  currency: string;
  provider: string;
  reason?: string;
};

const DISABLED_REGISTRAR_MESSAGE =
  "Custom domain purchasing is not available yet. Connect a real registrar integration before enabling this production feature.";

export type DomainPurchaseResult = {
  domain: string;
  registrarProvider: string;
  registrarDomainId: string;
  registrationExpiresAt: number;
  autoRenew: boolean;
};

export type DomainStatus = {
  domain: string;
  dnsStatus: "pending" | "configured" | "failed";
  sslStatus: "pending" | "active" | "failed";
};

export interface DomainRegistrarService {
  searchDomain(domain: string): Promise<DomainAvailability>;
  getDomainPrice(domain: string): Promise<{ price: number; currency: string }>;
  purchaseDomain(domain: string, dealerId: string): Promise<DomainPurchaseResult>;
  configureDns(domain: string, target: string): Promise<DomainStatus>;
  enableAutoRenew(domain: string): Promise<DomainStatus>;
  disableAutoRenew(domain: string): Promise<DomainStatus>;
  getDomainStatus(domain: string): Promise<DomainStatus>;
}

export class MockDomainRegistrarService implements DomainRegistrarService {
  private provider = "mock";

  async searchDomain(domain: string): Promise<DomainAvailability> {
    const available = !domain.includes("taken") && !domain.includes("unavailable");
    return {
      domain,
      available,
      price: domain.endsWith(".jo") ? 45 : 18,
      currency: "USD",
      provider: this.provider,
      reason: available ? undefined : "This domain is unavailable from the mock registrar.",
    };
  }

  async getDomainPrice(domain: string): Promise<{ price: number; currency: string }> {
    const result = await this.searchDomain(domain);
    return { price: result.price, currency: result.currency };
  }

  async purchaseDomain(domain: string, dealerId: string): Promise<DomainPurchaseResult> {
    return {
      domain,
      registrarProvider: this.provider,
      registrarDomainId: `mock_${dealerId}_${domain.replace(/[^a-z0-9]/g, "_")}`,
      registrationExpiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      autoRenew: true,
    };
  }

  async configureDns(domain: string, target: string): Promise<DomainStatus> {
    void target;
    return { domain, dnsStatus: "configured", sslStatus: "active" };
  }

  async enableAutoRenew(domain: string): Promise<DomainStatus> {
    return this.getDomainStatus(domain);
  }

  async disableAutoRenew(domain: string): Promise<DomainStatus> {
    return this.getDomainStatus(domain);
  }

  async getDomainStatus(domain: string): Promise<DomainStatus> {
    return { domain, dnsStatus: "configured", sslStatus: "active" };
  }
}

export class DisabledDomainRegistrarService implements DomainRegistrarService {
  private provider = "disabled";

  async searchDomain(domain: string): Promise<DomainAvailability> {
    return {
      domain,
      available: false,
      price: 0,
      currency: "USD",
      provider: this.provider,
      reason: DISABLED_REGISTRAR_MESSAGE,
    };
  }

  async getDomainPrice(domain: string): Promise<{ price: number; currency: string }> {
    void domain;
    throw new ConvexError(DISABLED_REGISTRAR_MESSAGE);
  }

  async purchaseDomain(domain: string, dealerId: string): Promise<DomainPurchaseResult> {
    void domain;
    void dealerId;
    throw new ConvexError(DISABLED_REGISTRAR_MESSAGE);
  }

  async configureDns(domain: string, target: string): Promise<DomainStatus> {
    void target;
    return { domain, dnsStatus: "failed", sslStatus: "failed" };
  }

  async enableAutoRenew(domain: string): Promise<DomainStatus> {
    void domain;
    throw new ConvexError(DISABLED_REGISTRAR_MESSAGE);
  }

  async disableAutoRenew(domain: string): Promise<DomainStatus> {
    void domain;
    throw new ConvexError(DISABLED_REGISTRAR_MESSAGE);
  }

  async getDomainStatus(domain: string): Promise<DomainStatus> {
    return { domain, dnsStatus: "failed", sslStatus: "failed" };
  }
}

const mockDomainRegistrarService = new MockDomainRegistrarService();
const disabledDomainRegistrarService = new DisabledDomainRegistrarService();

function currentDomainRegistrarService(): DomainRegistrarService {
  return process.env.DOMAIN_REGISTRAR_MODE === "mock"
    ? mockDomainRegistrarService
    : disabledDomainRegistrarService;
}

export const domainRegistrarService: DomainRegistrarService = {
  searchDomain(domain) {
    return currentDomainRegistrarService().searchDomain(domain);
  },
  getDomainPrice(domain) {
    return currentDomainRegistrarService().getDomainPrice(domain);
  },
  purchaseDomain(domain, dealerId) {
    return currentDomainRegistrarService().purchaseDomain(domain, dealerId);
  },
  configureDns(domain, target) {
    return currentDomainRegistrarService().configureDns(domain, target);
  },
  enableAutoRenew(domain) {
    return currentDomainRegistrarService().enableAutoRenew(domain);
  },
  disableAutoRenew(domain) {
    return currentDomainRegistrarService().disableAutoRenew(domain);
  },
  getDomainStatus(domain) {
    return currentDomainRegistrarService().getDomainStatus(domain);
  },
};
