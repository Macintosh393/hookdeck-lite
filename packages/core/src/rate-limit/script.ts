// The Lua script of the per-tenant rate limiter: a sliding-window counter.
// It is the script in docs/SECURITY.md#rate-limiting, line for line. Keep them in step.
// Decision and the alternatives: docs/adr/0010-rate-limiting.md

// LEARN: Redis runs a Lua script from start to finish without letting any other client's command
// in between. That makes "read the counters, decide, increment" one atomic step: two concurrent
// requests cannot both see the last free slot. Separate GET and INCR calls from Node could.
// See docs/learning/bullmq-101.md#lua-scripts
export const RATE_LIMIT_SCRIPT = `
-- KEYS[1] = current window key   hdl:rl:{tenantId}:{windowIndex}
-- KEYS[2] = previous window key  hdl:rl:{tenantId}:{windowIndex - 1}
-- ARGV[1] = limit   ARGV[2] = window length in ms   ARGV[3] = ms elapsed in the current window
local current  = tonumber(redis.call('GET', KEYS[1]) or '0')
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
local window   = tonumber(ARGV[2])
local elapsed  = tonumber(ARGV[3])
local weight   = (window - elapsed) / window
local estimate = previous * weight + current

if estimate >= tonumber(ARGV[1]) then
  return {0, window - elapsed}            -- rejected, ms until the current window ends
end

redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], window * 2)
return {1, 0}                             -- allowed
`;
