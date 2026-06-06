const fs = require('fs');
const path = 'e:/Auto/Auto/components/sales/SaleDialog.tsx';

let content = fs.readFileSync(path, 'utf8');

// Update Schema
const newSchema = `
const saleSchema = z.object({
  vehicleId: z.string().min(1, "Vehicle is required"),
  customerId: z.string().min(1, "Customer is required"),
  salespersonId: z.string().min(1, "Salesperson is required"),
  salePrice: z.coerce.number().min(0, "Sale price must be positive"),
  saleDate: z.string().min(1, "Sale date is required"),
  status: z.enum(["PENDING", "COMPLETED", "CANCELLED"]),
  
  // Deal Structuring
  taxRate: z.coerce.number().min(0).optional(),
  taxAmount: z.coerce.number().min(0).optional(),
  dealerFees: z.coerce.number().min(0).optional(),
  downPayment: z.coerce.number().min(0).optional(),
  tradeInVehicleId: z.string().optional(),
  tradeInValue: z.coerce.number().min(0).optional(),
  financingType: z.enum(["CASH", "FINANCED", "LEASE"]).optional(),
  loanAmount: z.coerce.number().min(0).optional(),
  apr: z.coerce.number().min(0).optional(),
  termMonths: z.coerce.number().min(0).optional(),
});
`;

content = content.replace(/const saleSchema = z\.object\(\{[^}]+\}\);/s, newSchema.trim());

// Update defaultValues
const newDefaultValues = `
      vehicleId: "",
      customerId: "",
      salespersonId: "",
      salePrice: 0,
      saleDate: new Date().toISOString().split('T')[0],
      status: "COMPLETED",
      taxRate: 0,
      taxAmount: 0,
      dealerFees: 0,
      downPayment: 0,
      tradeInVehicleId: "",
      tradeInValue: 0,
      financingType: "CASH",
      loanAmount: 0,
      apr: 0,
      termMonths: 0,
`;

content = content.replace(/defaultValues: \{[^}]+\},/s, `defaultValues: {\n${newDefaultValues}    },`);

// Update reset on edit
const newResetEdit = `        vehicleId: sale.vehicleId,
        customerId: sale.customerId,
        salespersonId: sale.salespersonId,
        salePrice: sale.salePrice,
        saleDate: date.toISOString().split('T')[0],
        status: sale.status,
        taxRate: sale.taxRate || 0,
        taxAmount: sale.taxAmount || 0,
        dealerFees: sale.dealerFees || 0,
        downPayment: sale.downPayment || 0,
        tradeInVehicleId: sale.tradeInVehicleId || "",
        tradeInValue: sale.tradeInValue || 0,
        financingType: sale.financingType || "CASH",
        loanAmount: sale.loanAmount || 0,
        apr: sale.apr || 0,
        termMonths: sale.termMonths || 0,`;

content = content.replace(/form\.reset\(\{\s+vehicleId: sale\.vehicleId,[\s\S]*?status: sale\.status,\s+\}\);/, `form.reset({\n${newResetEdit}\n      });`);

// Update reset on new
const newResetNew = `        vehicleId: "",
        customerId: "",
        salespersonId: "",
        salePrice: 0,
        saleDate: new Date().toISOString().split('T')[0],
        status: "COMPLETED",
        taxRate: 0,
        taxAmount: 0,
        dealerFees: 0,
        downPayment: 0,
        tradeInVehicleId: "",
        tradeInValue: 0,
        financingType: "CASH",
        loanAmount: 0,
        apr: 0,
        termMonths: 0,`;

content = content.replace(/form\.reset\(\{\s+vehicleId: "",[\s\S]*?status: "COMPLETED",\s+\}\);/, `form.reset({\n${newResetNew}\n      });`);

// Update submit payload for update
const newUpdatePayload = `
          salePrice: values.salePrice,
          saleDate: parsedDate,
          status: values.status,
          taxRate: values.taxRate,
          taxAmount: values.taxAmount,
          dealerFees: values.dealerFees,
          downPayment: values.downPayment,
          tradeInVehicleId: values.tradeInVehicleId ? values.tradeInVehicleId as Id<"vehicles"> : undefined,
          tradeInValue: values.tradeInValue,
          financingType: values.financingType,
          loanAmount: values.loanAmount,
          apr: values.apr,
          termMonths: values.termMonths,
`;
content = content.replace(/salePrice: values\.salePrice,\s+saleDate: parsedDate,\s+status: values\.status,/, newUpdatePayload.trim());

// Update submit payload for create
const newCreatePayload = `
          vehicleId: values.vehicleId as Id<"vehicles">,
          customerId: values.customerId as Id<"customers">,
          salespersonId: values.salespersonId as Id<"users">,
          salePrice: values.salePrice,
          saleDate: parsedDate,
          status: values.status,
          taxRate: values.taxRate,
          taxAmount: values.taxAmount,
          dealerFees: values.dealerFees,
          downPayment: values.downPayment,
          tradeInVehicleId: values.tradeInVehicleId ? values.tradeInVehicleId as Id<"vehicles"> : undefined,
          tradeInValue: values.tradeInValue,
          financingType: values.financingType,
          loanAmount: values.loanAmount,
          apr: values.apr,
          termMonths: values.termMonths,
`;
content = content.replace(/vehicleId: values\.vehicleId as Id<"vehicles">,[\s\S]*?status: values\.status,/, newCreatePayload.trim());

// We need to inject an effect to calculate loanAmount
const effectCode = `
  const salePrice = form.watch("salePrice");
  const taxAmount = form.watch("taxAmount");
  const dealerFees = form.watch("dealerFees");
  const downPayment = form.watch("downPayment");
  const tradeInValue = form.watch("tradeInValue");
  const financingType = form.watch("financingType");

  useEffect(() => {
    const total = (Number(salePrice) || 0) + (Number(taxAmount) || 0) + (Number(dealerFees) || 0) - (Number(downPayment) || 0) - (Number(tradeInValue) || 0);
    form.setValue("loanAmount", total > 0 ? total : 0);
  }, [salePrice, taxAmount, dealerFees, downPayment, tradeInValue, form]);
`;

content = content.replace('const onSubmit = async (values: SaleFormValues) => {', effectCode + '\n  const onSubmit = async (values: SaleFormValues) => {');

// Now we need to update the UI form. We'll replace the grid layout to include sections.
// Find the form children
const formRegex = /<div className="grid grid-cols-1 md:grid-cols-2 gap-4">([\s\S]*?)<\/div>\s*<div className="flex justify-end gap-2 pt-4">/m;

const newFormUI = `
            <div className="space-y-6">
              {/* Vehicle & Customer Section */}
              <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Vehicle & Customer</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {!sale && (
                    <>
                      <FormField
                        control={form.control}
                        name="vehicleId"
                        render={({ field }) => (
                          <FormItem className="md:col-span-2">
                            <FormLabel>Vehicle <span className="text-red-500">*</span></FormLabel>
                            <Select onValueChange={(val) => {
                              field.onChange(val);
                              const v = availableVehicles?.find(v => v._id === val);
                              if (v && form.getValues("salePrice") === 0) {
                                form.setValue("salePrice", v.sellingPrice);
                              }
                            }} defaultValue={field.value} value={field.value}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder="Select vehicle" /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {availableVehicles?.map((v) => (
                                  <SelectItem key={v._id} value={v._id}>
                                    {v.year} {v.make} {v.model} - {v.vin} (\${v.sellingPrice.toLocaleString()})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="customerId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Customer <span className="text-red-500">*</span></FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {customers?.map((c) => (
                                  <SelectItem key={c._id} value={c._id}>
                                    {c.firstName} {c.lastName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="salespersonId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Salesperson <span className="text-red-500">*</span></FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder="Select salesperson" /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {memberships?.map((m) => (
                                  <SelectItem key={m.userId} value={m.userId}>
                                    {m.userName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </>
                  )}
                  <FormField
                    control={form.control}
                    name="saleDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Sale Date <span className="text-red-500">*</span></FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="status"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Status</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="PENDING">Pending (Financing/Paperwork)</SelectItem>
                            <SelectItem value="COMPLETED">Completed (Delivered)</SelectItem>
                            <SelectItem value="CANCELLED">Cancelled (Refunded/Backed out)</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Pricing & Fees Section */}
              <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Pricing & Fees</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="salePrice"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Sale Price ($) <span className="text-red-500">*</span></FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="taxAmount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Taxes ($)</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="dealerFees"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Dealer Fees ($)</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Trade-In & Financing Section */}
              <div className="bg-muted/30 p-4 rounded-lg border space-y-4">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Financing & Trade-In</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="tradeInVehicleId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Trade-In Vehicle</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder="Select trade-in (optional)" /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="">None</SelectItem>
                            {availableVehicles?.map((v) => (
                              <SelectItem key={v._id} value={v._id}>
                                {v.year} {v.make} {v.model} - {v.vin}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">Vehicle must be added to inventory first.</p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="tradeInValue"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Trade-In Allowance ($)</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="downPayment"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Down Payment ($)</FormLabel>
                        <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="financingType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Financing Type</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                          <FormControl>
                            <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="CASH">Cash</SelectItem>
                            <SelectItem value="FINANCED">Financed</SelectItem>
                            <SelectItem value="LEASE">Lease</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  {financingType !== "CASH" && (
                    <>
                      <FormField
                        control={form.control}
                        name="apr"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>APR (%)</FormLabel>
                            <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="termMonths"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Term (Months)</FormLabel>
                            <FormControl><Input type="number" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </>
                  )}
                  
                  <FormField
                    control={form.control}
                    name="loanAmount"
                    render={({ field }) => (
                      <FormItem className="md:col-span-2">
                        <FormLabel>Total Out-the-Door / Loan Amount ($)</FormLabel>
                        <FormControl><Input type="number" step="0.01" disabled {...field} className="font-bold bg-muted" /></FormControl>
                        <p className="text-xs text-muted-foreground">Calculated automatically: Price + Tax + Fees - Down Payment - Trade-In</p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
            </div>
            
            <div className="flex justify-end gap-2 pt-4">
`;

content = content.replace(formRegex, newFormUI);

// The component had <SelectItem value="">None</SelectItem>, wait, value="" might trigger error if it requires min(1).
// the schema has tradeInVehicleId: z.string().optional() so it should be fine. But z.string().optional() might get "" which is still a string. It's better to pass undefined.
// In the submit handler, we do `tradeInVehicleId: values.tradeInVehicleId ? values.tradeInVehicleId as Id<"vehicles"> : undefined` so it's fine.

fs.writeFileSync('e:/Auto/Auto/components/sales/SaleDialog.tsx', content);
console.log("SaleDialog updated");
