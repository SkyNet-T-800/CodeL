export function createAsyncCache(loader) {
  return {
    async get(key) {
      return await loader(key);
    }
  };
}
