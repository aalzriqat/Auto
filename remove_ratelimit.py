import re

with open('convex/reports.ts', 'r') as f:
    content = f.read()

# Remove the rate limiter import
content = re.sub(r'import\s+\{\s*rateLimiter\s*\}\s*from\s*\"./rateLimit\";\n', '', content)

# Remove the rate limit checks
pattern = r'\s*const statusLimit = await rateLimiter\.limit\(ctx,\s*"heavyRead",\s*\{\s*key:\s*args\.orgId\s*\}\);\s*if\s*\(!statusLimit\.ok\)\s*\{\s*throw new ConvexError\(`Rate limit exceeded for reports\. Try again in \$\{Math\.ceil\(statusLimit\.retryAfter\s*/\s*1000\)\}s`\);\s*\}'
content = re.sub(pattern, '', content)

with open('convex/reports.ts', 'w') as f:
    f.write(content)
