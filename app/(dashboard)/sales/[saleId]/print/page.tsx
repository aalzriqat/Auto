"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { format } from "date-fns";
import { Loader2, Printer, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export default function PrintBillOfSalePage() {
  const params = useParams();
  const router = useRouter();
  const { activeOrgId } = useOrg();
  const saleId = params.saleId as Id<"sales">;
  
  const sale = useQuery(api.sales.get, activeOrgId ? { orgId: activeOrgId, saleId } : "skip");
  const [hasPrinted, setHasPrinted] = useState(false);

  useEffect(() => {
    // Add a print-specific class to body when mounted to hide other layout elements if needed
    document.body.classList.add("print-mode");
    return () => {
      document.body.classList.remove("print-mode");
    };
  }, []);

  if (sale === undefined) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (sale === null || !sale.vehicle || !sale.customer) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <p className="text-xl font-bold mb-4">Sale record not found or incomplete.</p>
        <Button onClick={() => router.back()}>Go Back</Button>
      </div>
    );
  }

  const { vehicle, customer } = sale;
  const orgName = "Auto Dealership"; // Ideally fetched from org settings

  return (
    <div className="min-h-screen bg-white">
      {/* Non-printable header */}
      <div className="print:hidden p-4 flex justify-between items-center bg-muted border-b">
        <Button variant="outline" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 me-2" /> Back
        </Button>
        <Button onClick={() => window.print()}>
          <Printer className="h-4 w-4 me-2" /> Print Document
        </Button>
      </div>

      {/* Printable Area */}
      <div className="max-w-4xl mx-auto p-12 bg-white text-black" id="printable-area">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold uppercase tracking-widest border-b-4 border-black pb-4 mb-2">
            Bill of Sale
          </h1>
          <p className="text-xl font-semibold">{orgName}</p>
          <p className="text-sm">Official Record of Transaction</p>
        </div>

        <div className="grid grid-cols-2 gap-12 mb-8">
          <div>
            <h2 className="text-lg font-bold border-b border-black mb-2 uppercase">Seller Information</h2>
            <p className="font-semibold">{orgName}</p>
            <p>Salesperson: {sale.salesperson?.name || "Unknown"}</p>
          </div>
          <div>
            <h2 className="text-lg font-bold border-b border-black mb-2 uppercase">Buyer Information</h2>
            <p className="font-semibold">{customer.firstName} {customer.lastName}</p>
            <p>Address: {customer.address || "N/A"}</p>
            <p>Phone: {customer.phone || "N/A"}</p>
            <p>Email: {customer.email || "N/A"}</p>
            <p>National ID: {customer.nationalId || "N/A"}</p>
          </div>
        </div>

        <div className="mb-8">
          <h2 className="text-lg font-bold border-b border-black mb-2 uppercase">Vehicle Description</h2>
          <table className="w-full text-left text-sm border-collapse">
            <tbody>
              <tr className="border-b">
                <th className="py-2 font-semibold">Make</th>
                <td className="py-2">{vehicle.make}</td>
                <th className="py-2 font-semibold">Model</th>
                <td className="py-2">{vehicle.model}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">Year</th>
                <td className="py-2">{vehicle.year}</td>
                <th className="py-2 font-semibold">Trim</th>
                <td className="py-2">{vehicle.trim || "N/A"}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">VIN</th>
                <td className="py-2 font-mono font-bold tracking-wider">{vehicle.vin}</td>
                <th className="py-2 font-semibold">Color</th>
                <td className="py-2">{vehicle.color}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">Mileage</th>
                <td className="py-2">{vehicle.mileage.toLocaleString()}</td>
                <th className="py-2 font-semibold">Fuel Type</th>
                <td className="py-2">{vehicle.fuelType}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mb-12">
          <h2 className="text-lg font-bold border-b border-black mb-2 uppercase">Financial Details</h2>
          <table className="w-full text-left text-sm border-collapse">
            <tbody>
              <tr className="border-b">
                <th className="py-2 font-semibold">Sale Price</th>
                <td className="py-2 text-right">{sale.salePrice.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">Dealer Fees</th>
                <td className="py-2 text-right">{(sale.dealerFees || 0).toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">Taxes</th>
                <td className="py-2 text-right">{(sale.taxAmount || 0).toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">Extended Warranty</th>
                <td className="py-2 text-right">{(sale.warrantySold || 0).toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">GAP Insurance</th>
                <td className="py-2 text-right">{(sale.gapSold || 0).toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</td>
              </tr>
              <tr className="border-b text-red-700">
                <th className="py-2 font-semibold">Trade-in Allowance</th>
                <td className="py-2 text-right">-{(sale.tradeInValue || 0).toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</td>
              </tr>
              <tr className="border-b text-red-700">
                <th className="py-2 font-semibold">Down Payment</th>
                <td className="py-2 text-right">-{(sale.downPayment || 0).toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</td>
              </tr>
              <tr className="border-b-2 border-black bg-gray-50">
                <th className="py-3 font-bold text-base">Total Amount Due / Financed</th>
                <td className="py-3 text-right font-bold text-base">{(sale.loanAmount || 0).toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</td>
              </tr>
            </tbody>
          </table>
          <p className="text-xs text-gray-500 mt-2">
            Payment Method: {sale.financingType}
            {sale.financingType === "FINANCED" && sale.termMonths && sale.apr ? 
              ` • ${sale.termMonths} Months @ ${sale.apr}% APR` : ''}
          </p>
        </div>

        <div className="mb-12">
          <p className="text-sm leading-relaxed mb-4 text-justify">
            I, the undersigned buyer, acknowledge receipt of this Bill of Sale and understand there is no guarantee or warranty, expressed or implied, with respect to the above-described property. It is also understood that the above-stated vehicle is sold in "AS IS" condition.
          </p>
          <p className="text-sm font-semibold mb-12">
            Odometer Disclosure Statement: The seller certifies that to the best of their knowledge the odometer reading reflects the actual mileage of the vehicle described herein unless indicated otherwise.
          </p>

          <div className="grid grid-cols-2 gap-12 mt-16">
            <div>
              <div className="border-b border-black h-8 mb-2"></div>
              <p className="font-semibold text-sm">Seller Signature</p>
              <p className="text-xs mt-1">Date: {format(sale.saleDate, "PP")}</p>
            </div>
            <div>
              <div className="border-b border-black h-8 mb-2"></div>
              <p className="font-semibold text-sm">Buyer Signature ({customer.firstName} {customer.lastName})</p>
              <p className="text-xs mt-1">Date: {format(sale.saleDate, "PP")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
