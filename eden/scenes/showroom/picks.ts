// The music in Aurral's screenshots. `owned` albums are in the Library; every other
// artist is out in the world for Discover, search, and imports to find. `lab` reuses
// an artist Eden's main catalogue already recorded from MusicBrainz.

export type Pick = {
  name: string;
  genres: string[];
  owned?: string[];
  albums?: string[];
  lab?: string;
};

export const SHOWROOM_PICKS: Pick[] = [
  {
    name: "The Hotelier",
    genres: ["Emo", "Punk Rock", "Indie Rock"],
    owned: ["Home, Like Noplace Is There"],
  },
  { name: "Sunny Day Real Estate", genres: ["Emo", "Indie Rock", "Rock"], owned: ["Diary"] },
  {
    name: "The Movielife",
    genres: ["Pop Punk", "Emo", "Punk"],
    owned: ["This Time Next Year"],
  },
  {
    name: "Funeral For A Friend",
    genres: ["Post-Hardcore", "Emo", "Rock"],
    owned: ["Hours"],
  },
  {
    name: "Hot Water Music",
    genres: ["Punk", "Post-Hardcore", "Emo"],
    owned: ["Fuel for the Hate Game"],
  },
  { name: "Grade", genres: ["Post-Hardcore", "Emo"], owned: ["The Embarrassing Beginning"] },
  { name: "Hey Mercedes", genres: ["Emo", "Indie Rock"], owned: ["Everynight Fire Works"] },
  { name: "Nai Harvest", genres: ["Emo", "Indie Rock", "Lo Fi"], owned: ["Hairball"] },
  {
    name: "New Found Glory",
    genres: ["Pop Punk", "Punk Rock"],
    owned: ["Nothing Gold Can Stay"],
  },
  {
    name: "At the Drive-In",
    genres: ["Post-Hardcore", "Alternative Rock"],
    owned: ["In/Casino/Out"],
  },
  {
    name: "Jimmy Eat World",
    genres: ["Emo", "Alternative Rock", "Rock"],
    owned: ["Clarity", "Bleed American"],
  },
  { name: "Jawbreaker", genres: ["Punk", "Emo", "Punk Rock"], owned: ["Dear You"] },
  { name: "Jawbox", genres: ["Post-Hardcore", "Alternative Rock"], owned: ["Jawbox"] },
  { name: "Joan of Arc", genres: ["Emo", "Indie Rock"], owned: ["A Portable Model Of"] },
  { name: "Saves The Day", genres: ["Pop Punk", "Emo"], owned: ["Through Being Cool"] },
  {
    name: "Motion City Soundtrack",
    genres: ["Pop Punk", "Emo", "Indie Rock"],
    owned: ["I Am the Movie"],
  },
  { name: "Samiam", genres: ["Punk", "Emo", "Rock"], owned: ["Clumsy"] },
  { name: "Bayside", genres: ["Pop Punk", "Emo"], owned: ["Bayside"] },
  {
    name: "The Get Up Kids",
    genres: ["Emo", "Indie Rock"],
    owned: ["Something to Write Home About"],
  },
  { name: "American Football", genres: ["Emo", "Indie Rock"], owned: ["American Football"] },
  { name: "Taking Back Sunday", genres: ["Emo", "Pop Punk"], owned: ["Tell All Your Friends"] },
  { name: "Brand New", genres: ["Emo", "Alternative Rock"], owned: ["Deja Entendu"] },
  { name: "Misfits", genres: ["Punk", "Punk Rock"], owned: ["American Psycho", "Static Age"] },
  {
    name: "The Front Bottoms",
    genres: ["Indie Rock", "Pop Punk"],
    owned: ["The Front Bottoms", "Talon of the Hawk"],
  },
  {
    name: "Fall Out Boy",
    genres: ["Pop Punk", "Emo", "Rock"],
    owned: ["From Under the Cork Tree"],
  },
  { name: "Backstreet Boys", genres: ["Pop"], owned: ["Backstreet's Back"] },
  {
    name: "Bad Bunny",
    genres: ["Latin", "Reggaeton"],
    lab: "89aa5ecb-59ad-46f5-b3eb-2d424e941f19",
  },
  { name: "Thursday", genres: ["Post-Hardcore", "Emo"], albums: ["Full Collapse"] },
  { name: "Have Mercy", genres: ["Emo", "Indie Rock"], albums: ["The Earth Pushed Back"] },
  { name: "Stick and Poke", genres: ["Emo", "Indie Rock"] },
  {
    name: "Foo Fighters",
    genres: ["Alternative Rock", "Rock"],
    albums: ["The Colour and the Shape"],
  },
  { name: "METZ", genres: ["Punk", "Post-Hardcore"], albums: ["METZ"] },
  { name: "Cloud Nothings", genres: ["Indie Rock", "Punk"], albums: ["Attack on Memory"] },
  { name: "The Bled", genres: ["Post-Hardcore"], albums: ["Pass the Flask"] },
  { name: "Title Fight", genres: ["Emo", "Punk", "Post-Hardcore"], albums: ["Floral Green"] },
  { name: "Tigers Jaw", genres: ["Emo", "Indie Rock"], albums: ["Tigers Jaw"] },
  { name: "Modern Baseball", genres: ["Emo", "Pop Punk"], albums: ["You're Gonna Miss It All"] },
  { name: "Turnover", genres: ["Emo", "Indie Rock"], albums: ["Peripheral Vision"] },
  { name: "Mineral", genres: ["Emo", "Indie Rock"], albums: ["The Power of Failing"] },
  {
    name: "Thrice",
    genres: ["Post-Hardcore", "Alternative Rock"],
    albums: ["The Artist in the Ambulance"],
  },
  {
    name: "The Naked and Famous",
    genres: ["Indie Pop", "Indie"],
    albums: ["Passive Me, Aggressive You"],
  },
  { name: "MGMT", genres: ["Indie", "Indie Pop"], albums: ["Oracular Spectacular"] },
  { name: "Empire of the Sun", genres: ["Indie Pop", "Pop"], albums: ["Walking on a Dream"] },
  { name: "Yeah Yeah Yeahs", genres: ["Indie Rock", "Indie"], albums: ["It's Blitz!"] },
  { name: "Caribou", genres: ["Indie", "Pop"], albums: ["Swim"] },
  { name: "The Ting Tings", genres: ["Indie Pop", "Pop"], albums: ["We Started Nothing"] },
  { name: "The Virgins", genres: ["Indie Rock", "Indie"], albums: ["The Virgins"] },
  { name: "The xx", genres: ["Indie", "Indie Pop"], albums: ["xx"] },
  { name: "M.I.A.", genres: ["Pop", "Alternative"], albums: ["Kala"] },
  { name: "CHVRCHES", genres: ["Indie Pop", "Pop"], albums: ["The Bones of What You Believe"] },
];
