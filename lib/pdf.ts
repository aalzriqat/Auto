import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export interface CompanyInfo {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
}

export interface CustomerInfo {
  name: string;
  email?: string;
  phone?: string;
}

export interface VehicleInfo {
  make: string;
  model: string;
  year: number;
  vin: string;
  color?: string;
  mileage?: number;
}

export interface PricingInfo {
  basePrice: number;
  taxes: number;
  fees: number;
  total: number;
}

export const generateBillOfSale = (
  companyName: string,
  customerName: string,
  vehicleSummary: string,
  vehicleVin: string,
  salePrice: number,
  saleDate: string | number
) => {
  const doc = new jsPDF();
  const dateStr = typeof saleDate === 'number' ? new Date(saleDate).toLocaleDateString() : saleDate;

  // Header
  doc.setFontSize(22);
  doc.text("BILL OF SALE", 105, 20, { align: "center" });

  doc.setFontSize(10);
  doc.text(`Date: ${dateStr}`, 15, 30);
  
  // Dealership Info
  doc.setFontSize(12);
  doc.text("Seller Information", 15, 45);
  doc.setFontSize(10);
  doc.text(`Company: ${companyName}`, 15, 52);

  // Customer Info
  doc.setFontSize(12);
  doc.text("Buyer Information", 110, 45);
  doc.setFontSize(10);
  doc.text(`Name: ${customerName}`, 110, 52);

  // Vehicle Details
  doc.setFontSize(14);
  doc.text("Vehicle Description", 15, 80);
  
  autoTable(doc, {
    startY: 85,
    head: [['Vehicle', 'VIN']],
    body: [
      [
        vehicleSummary, 
        vehicleVin
      ],
    ],
    theme: 'grid',
    headStyles: { fillColor: [41, 128, 185] }
  });

  // Pricing
  const currentY = (doc as any).lastAutoTable.finalY + 15;
  doc.setFontSize(14);
  doc.text("Pricing Summary", 15, currentY);

  autoTable(doc, {
    startY: currentY + 5,
    body: [
      ['Vehicle Price:', `$${salePrice.toLocaleString(undefined, {minimumFractionDigits: 2})}`],
      ['Total Amount Paid:', `$${salePrice.toLocaleString(undefined, {minimumFractionDigits: 2})}`],
    ],
    theme: 'plain',
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 100 },
      1: { halign: 'right' }
    }
  });

  // Signatures
  const sigY = (doc as any).lastAutoTable.finalY + 30;
  doc.setFontSize(10);
  doc.text("_________________________________", 15, sigY);
  doc.text("Seller Signature", 15, sigY + 5);

  doc.text("_________________________________", 110, sigY);
  doc.text("Buyer Signature", 110, sigY + 5);

  // Footer Disclaimer
  doc.setFontSize(8);
  doc.text("This vehicle is sold 'AS IS' unless otherwise stated. All sales are final.", 105, 280, { align: "center" });

  doc.save(`Bill_of_Sale_${customerName.replace(/\s+/g, '_')}_${vehicleVin.slice(-6)}.pdf`);
};

export const generateQuote = (
  companyName: string,
  customerName: string,
  vehicleSummary: string,
  vehicleVin: string,
  estimatedPrice: number
) => {
  const doc = new jsPDF();
  const dateStr = new Date().toLocaleDateString();

  // Header
  doc.setFontSize(22);
  doc.text("VEHICLE PURCHASE QUOTE", 105, 20, { align: "center" });

  doc.setFontSize(10);
  doc.text(`Date Valid: ${dateStr}`, 15, 30);
  
  // Dealership Info
  doc.setFontSize(12);
  doc.text("Dealership Information", 15, 45);
  doc.setFontSize(10);
  doc.text(`Company: ${companyName}`, 15, 52);

  // Customer Info
  doc.setFontSize(12);
  doc.text("Prepared For", 110, 45);
  doc.setFontSize(10);
  doc.text(`Name: ${customerName}`, 110, 52);

  // Vehicle Details
  doc.setFontSize(14);
  doc.text("Vehicle Description", 15, 80);
  
  autoTable(doc, {
    startY: 85,
    head: [['Vehicle', 'VIN']],
    body: [
      [
        vehicleSummary, 
        vehicleVin || 'TBD'
      ],
    ],
    theme: 'grid',
    headStyles: { fillColor: [52, 73, 94] }
  });

  // Pricing
  const currentY = (doc as any).lastAutoTable.finalY + 15;
  doc.setFontSize(14);
  doc.text("Estimated Pricing", 15, currentY);

  autoTable(doc, {
    startY: currentY + 5,
    body: [
      ['Estimated Total:', `$${(estimatedPrice || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}`],
    ],
    theme: 'plain',
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 100 },
      1: { halign: 'right' }
    }
  });

  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text("This quote is valid for 7 days. Taxes and fees are estimates and subject to final negotiation.", 15, (doc as any).lastAutoTable.finalY + 15);

  doc.save(`Quote_${customerName.replace(/\s+/g, '_')}.pdf`);
};

export const generateFinanceQuote = (
  companyName: string,
  customerName: string,
  vehicleSummary: string,
  financeCompanyName: string,
  vehiclePrice: number,
  downPayment: number,
  termMonths: number,
  profitRate: number,
  financedAmount: number,
  totalProfit: number,
  monthlyInstallment: number
) => {
  const doc = new jsPDF();
  const dateStr = new Date().toLocaleDateString();

  // Header
  doc.setFontSize(22);
  doc.text("FINANCING QUOTE (عرض سعر تمويل)", 105, 20, { align: "center" });

  doc.setFontSize(10);
  doc.text(`Date Valid: ${dateStr}`, 15, 30);
  
  // Dealership Info
  doc.setFontSize(12);
  doc.text("Dealership Information", 15, 45);
  doc.setFontSize(10);
  doc.text(`Company: ${companyName}`, 15, 52);

  // Customer Info
  doc.setFontSize(12);
  doc.text("Prepared For", 110, 45);
  doc.setFontSize(10);
  doc.text(`Name: ${customerName}`, 110, 52);

  // Vehicle & Financing Company
  doc.setFontSize(14);
  doc.text("Vehicle & Financing Details", 15, 75);
  
  autoTable(doc, {
    startY: 80,
    head: [['Vehicle Description', 'Financing Company']],
    body: [
      [vehicleSummary, financeCompanyName],
    ],
    theme: 'grid',
    headStyles: { fillColor: [52, 73, 94] }
  });

  // Pricing & Calculations
  const currentY = (doc as any).lastAutoTable.finalY + 15;
  doc.setFontSize(14);
  doc.text("Calculation Breakdown", 15, currentY);

  autoTable(doc, {
    startY: currentY + 5,
    body: [
      ['Vehicle Price:', `${vehiclePrice.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD`],
      ['Down Payment:', `${downPayment.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD`],
      ['Term Length:', `${termMonths} Months`],
      ['Annual Profit Rate:', `${profitRate}%`],
      ['Total Financed Amount:', `${financedAmount.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD`],
      ['Total Profit:', `${totalProfit.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD`],
      ['Monthly Installment:', `${monthlyInstallment.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD`],
    ],
    theme: 'striped',
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 100 },
      1: { halign: 'right' }
    }
  });

  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text("This quote is valid for 7 days. Calculations are estimates and subject to final approval by the financing company.", 15, (doc as any).lastAutoTable.finalY + 15);

  doc.save(`Finance_Quote_${customerName.replace(/\s+/g, '_')}.pdf`);
};

