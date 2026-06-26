export type DomainAvailability = {
  domain: string;
  available: boolean;
  price: number;
  currency: string;
  provider: string;
  reason?: string;
};

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

export const domainRegistrarService: DomainRegistrarService = new MockDomainRegistrarService();
