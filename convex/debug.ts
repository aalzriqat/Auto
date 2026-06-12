import { internalQuery } from "./_generated/server";
export const inspect = internalQuery({
  args: {},
  handler: async (ctx) => {
    const vehicles = await ctx.db.query("vehicles").collect();
    const expenses = await ctx.db.query("expenses").collect();
    return { vehicles, expenses };
  },
});
