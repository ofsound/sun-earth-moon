declare module "tz-lookup" {
  const tzlookup: (latitude: number, longitude: number) => string;
  export default tzlookup;
}
