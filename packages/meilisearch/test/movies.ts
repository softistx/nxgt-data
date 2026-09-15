import { defineIndex } from '../src';

export interface Movie {
	id: number;
	title: string;
	overview: string;
	year: number;
	rating: number;
	genres: string[];
	director: { name: string; country: string };
}

/** The definition the specs sync and query: most settings, some nested. */
export const movies = defineIndex<Movie>()({
	uid: 'movies',
	primaryKey: 'id',
	settings: {
		searchableAttributes: ['title', 'overview', 'director.name'],
		filterableAttributes: ['genres', 'year', 'director.name'],
		sortableAttributes: ['year', 'rating'],
		displayedAttributes: ['*'],
		rankingRules: [
			'words',
			'typo',
			'proximity',
			'attribute',
			'sort',
			'exactness',
			'rating:desc',
		],
		synonyms: { scifi: ['science fiction'], 'science fiction': ['scifi'] },
		stopWords: ['the', 'a', 'of'],
		typoTolerance: {
			minWordSizeForTypos: { oneTypo: 4 },
			disableOnAttributes: ['year'],
		},
		faceting: { maxValuesPerFacet: 50, sortFacetValuesBy: { genres: 'count' } },
		pagination: { maxTotalHits: 500 },
		separatorTokens: ['|'],
		proximityPrecision: 'byAttribute',
	},
});

export const sampleMovies: Movie[] = [
	{
		id: 1,
		title: 'Alien',
		overview: 'A crew meets a deadly creature in space',
		year: 1979,
		rating: 8.5,
		genres: ['horror', 'scifi'],
		director: { name: 'Ridley Scott', country: 'UK' },
	},
	{
		id: 2,
		title: 'Blade Runner',
		overview: 'A blade runner hunts replicants in Los Angeles',
		year: 1982,
		rating: 8.1,
		genres: ['scifi', 'noir'],
		director: { name: 'Ridley Scott', country: 'UK' },
	},
	{
		id: 3,
		title: 'Heat',
		overview: 'A detective hunts a crew of thieves in Los Angeles',
		year: 1995,
		rating: 8.3,
		genres: ['crime'],
		director: { name: 'Michael Mann', country: 'US' },
	},
	{
		id: 4,
		title: 'Arrival',
		overview: 'A linguist talks to visitors from space',
		year: 2016,
		rating: 7.9,
		genres: ['scifi', 'drama'],
		director: { name: 'Denis Villeneuve', country: 'CA' },
	},
];
