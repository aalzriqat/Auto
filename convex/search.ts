import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";

type VehicleResult = {
  id: Id<"vehicles">;
  make: string;
  model: string;
  vin: string;
  year: number;
  status: string;
};

type CustomerResult = {
  id: Id<"customers">;
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
};

type LeadResult = {
  id: Id<"leads">;
  stage: string;
  customerId: Id<"customers">;
  customerName: string;
};

export const globalSearch = query({
  args: {
    orgId: v.id("organizations"),
    query: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);

    const searchTerm = args.query.trim();
    if (searchTerm.length < 2) {
      return { vehicles: [], customers: [], leads: [] };
    }

    const [vehiclesByMake, vehiclesByVin, customersByFirstName, customersByLastName] = await Promise.all([
      ctx.db
        .query("vehicles")
        .withSearchIndex("search_make", (q) => q.search("make", searchTerm).eq("orgId", args.orgId))
        .take(10),
      ctx.db
        .query("vehicles")
        .withSearchIndex("search_vin", (q) => q.search("vin", searchTerm).eq("orgId", args.orgId))
        .take(10),
      ctx.db
        .query("customers")
        .withSearchIndex("search_firstName", (q) => q.search("firstName", searchTerm).eq("orgId", args.orgId))
        .take(10),
      ctx.db
        .query("customers")
        .withSearchIndex("search_lastName", (q) => q.search("lastName", searchTerm).eq("orgId", args.orgId))
        .take(10),
    ]);

    const vehicleMap = new Map<Id<"vehicles">, VehicleResult>();
    for (const vehicle of [...vehiclesByMake, ...vehiclesByVin]) {
      if (vehicle.orgId !== args.orgId || vehicle.isDeleted === true || vehicleMap.has(vehicle._id)) {
        continue;
      }
      vehicleMap.set(vehicle._id, {
        id: vehicle._id,
        make: vehicle.make,
        model: vehicle.model,
        vin: vehicle.vin,
        year: vehicle.year,
        status: vehicle.status,
      });
      if (vehicleMap.size >= 5) break;
    }

    const customerMap = new Map<Id<"customers">, CustomerResult>();
    for (const customer of [...customersByFirstName, ...customersByLastName]) {
      if (customer.orgId !== args.orgId || customer.isDeleted === true || customerMap.has(customer._id)) {
        continue;
      }
      customerMap.set(customer._id, {
        id: customer._id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        email: customer.email,
      });
      if (customerMap.size >= 5) break;
    }

    const leads: LeadResult[] = [];
    for (const customer of customerMap.values()) {
      const customerLeads = await ctx.db
        .query("leads")
        .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", customer.id))
        .take(5);

      for (const lead of customerLeads) {
        if (lead.isDeleted === true) continue;
        leads.push({
          id: lead._id,
          stage: lead.stage,
          customerId: lead.customerId,
          customerName: `${customer.firstName} ${customer.lastName}`.trim(),
        });
        if (leads.length >= 5) break;
      }
      if (leads.length >= 5) break;
    }

    return {
      vehicles: Array.from(vehicleMap.values()),
      customers: Array.from(customerMap.values()),
      leads,
    };
  },
});
