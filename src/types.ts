export interface GalleryImage {
  t: 'j' | 'p' | 'g';
  w: number;
  h: number;
}

export interface GalleryImages {
  pages: GalleryImage[];
  cover: GalleryImage;
  thumbnail: GalleryImage;
}

export interface Title {
  english: string;
  japanese: string;
  pretty: string;
}

export interface Tag {
  id: number;
  type: 'tag' | 'category' | 'artist' | 'parody' | 'character' | 'group' | 'language';
  name: string;
  url: string;
  count: number;
}

export interface Gallery {
  id: string;
  media_id: string;
  title: Title;
  images: GalleryImages;
  scanlator: string;
  upload_date: number;
  tags: Tag[];
  num_pages: number;
  num_favorites: number;
}

export interface SearchResult {
  result: Partial<Gallery>[];
  num_pages: number;
  per_page: number;
}