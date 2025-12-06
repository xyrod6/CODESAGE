# CODESAGE Tests

This directory contains test files for validating the CODESAGE indexing and dependency resolution functionality.

## Test Files

### `test-indexing.ts`
Comprehensive end-to-end test that validates:
- Project indexing pipeline
- Symbol extraction and storage
- Dependency resolution
- PageRank computation
- Project metadata
- Symbol search functionality

**Usage:**
```bash
npx tsx tests/test-indexing.ts
```

### `test-detailed.ts`
Detailed diagnostic test focusing on:
- PageRank score storage and retrieval
- Dependency structure validation
- Cross-file import resolution

**Usage:**
```bash
npx tsx tests/test-detailed.ts
```

### `test-imports.ts`
Focused test for import dependency extraction:
- Validates import statement parsing
- Checks dependency edge structure
- Tests filepath preservation

**Usage:**
```bash
npx tsx tests/test-imports.ts
```

## Prerequisites

Before running tests:

1. **Start Redis:**
   ```bash
   redis-server
   # or
   brew services start redis
   ```

2. **Build the project:**
   ```bash
   npm run build
   ```

3. **Optional - Flush Redis (for clean test):**
   ```bash
   redis-cli FLUSHDB
   ```

## Expected Results

A successful test run should show:
- ✅ 5,000+ symbols indexed
- ✅ 20,000+ dependencies resolved
- ✅ 4,000+ cross-file imports
- ✅ PageRank scores computed for all symbols
- ✅ Project metadata stored correctly

See `INDEXING_TEST_SUMMARY.md` for detailed test results and fixes applied.

## Running All Tests

```bash
# Full test suite
npm run build && npx tsx tests/test-indexing.ts

# Quick validation
npx tsx tests/test-detailed.ts
```
