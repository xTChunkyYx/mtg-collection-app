import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  doc, 
  updateDoc, 
  deleteDoc, 
  onSnapshot,
  query,
  where 
} from 'firebase/firestore';
import { 
  getAuth, 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  Search, 
  Plus, 
  Trash2, 
  ArrowLeftRight, 
  Upload, 
  Database, 
  TrendingUp, 
  PackageCheck,
  Sparkles,
  Layers,
  LogOut,
  LogIn,
  UserPlus
} from 'lucide-react';

// 1. Your Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyBMQ0tEGF7v06xvo2LeiNkVPwibJk1epEg",
  authDomain: "mtg-collection-dsmith.firebaseapp.com",
  projectId: "mtg-collection-dsmith",
  storageBucket: "mtg-collection-dsmith.firebasestorage.app",
  messagingSenderId: "836673876771",
  appId: "1:836673876771:web:2af9236da4f02c7e9a9296",
  measurementId: "G-ZKMB48LSG5"
};

// 2. Initialize Firebase in correct order
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Helper for Scryfall Mana Colors
const renderManaBadges = (colors = []) => {
  if (!colors || colors.length === 0) return <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded">Colorless</span>;
  const colorMap = {
    W: 'bg-yellow-100 text-yellow-900 border-yellow-300',
    U: 'bg-blue-600 text-white',
    B: 'bg-gray-900 text-gray-200 border-gray-700',
    R: 'bg-red-600 text-white',
    G: 'bg-emerald-600 text-white'
  };
  return (
    <div className="flex gap-1">
      {colors.map((c) => (
        <span key={c} className={`text-xs font-bold px-1.5 py-0.5 rounded border ${colorMap[c] || 'bg-gray-700 text-white'}`}>
          {c}
        </span>
      ))}
    </div>
  );
};

export default function App() {
  // Auth State
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);

  // App Navigation & Data State
  const [activeTab, setActiveTab] = useState('collection');
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Search & Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedColor, setSelectedColor] = useState('ALL');
  const [selectedRarity, setSelectedRarity] = useState('ALL');
  
  // Scryfall Auto-complete state
  const [queryName, setQueryName] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedScryfallCard, setSelectedScryfallCard] = useState(null);
  const [addQuantity, setAddQuantity] = useState(1);
  const [isFoil, setIsFoil] = useState(false);

  // CSV Import State
  const [csvText, setCsvText] = useState('');
  const [importStatus, setImportStatus] = useState('');

  // Trade Calculator State
  const [offeredCards, setOfferedCards] = useState([]);
  const [requestedCards, setRequestedCards] = useState([]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Fetch cards belonging ONLY to logged-in user
  useEffect(() => {
    if (!user) {
      setCards([]);
      return;
    }

    setLoading(true);
    const q = query(collection(db, 'cards'), where("userId", "==", user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const cardsData = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
      }));
      setCards(cardsData);
      setLoading(false);
    }, (error) => {
      console.error("Firestore snapshot error:", error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  // Auth Handlers
  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (isRegistering) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      setEmail('');
      setPassword('');
    } catch (err) {
      setAuthError(err.message.replace('Firebase: ', ''));
    }
  };

  const handleLogout = () => signOut(auth);

  // Scryfall API Card Autocomplete
  useEffect(() => {
    if (queryName.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(queryName)}`);
        const data = await res.json();
        setSearchResults(data.data || []);
      } catch (err) {
        console.error("Scryfall fetch error:", err);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [queryName]);

  const handleSelectCardName = async (name) => {
    setQueryName(name);
    setSearchResults([]);
    setIsSearching(true);
    try {
      const res = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
      const cardData = await res.json();
      setSelectedScryfallCard(cardData);
    } catch (err) {
      console.error("Scryfall details fetch error:", err);
    } finally {
      setIsSearching(false);
    }
  };

  // Add Card to Firebase Collection with userId attached
  const handleAddCardToCollection = async () => {
    if (!selectedScryfallCard || !user) return;

    const price = selectedScryfallCard.prices?.usd 
      ? parseFloat(selectedScryfallCard.prices.usd) 
      : (selectedScryfallCard.prices?.usd_foil ? parseFloat(selectedScryfallCard.prices.usd_foil) : 0);

    const imageUrl = selectedScryfallCard.image_uris?.normal || selectedScryfallCard.card_faces?.[0]?.image_uris?.normal || '';

    const existingIndex = cards.findIndex(c => c.name.toLowerCase() === selectedScryfallCard.name.toLowerCase() && c.isFoil === isFoil);

    if (existingIndex > -1) {
      const existingCard = cards[existingIndex];
      const cardRef = doc(db, 'cards', existingCard.id);
      await updateDoc(cardRef, {
        quantity: existingCard.quantity + parseInt(addQuantity, 10)
      });
    } else {
      await addDoc(collection(db, 'cards'), {
        userId: user.uid,
        name: selectedScryfallCard.name,
        setName: selectedScryfallCard.set_name || 'Unknown Set',
        setCode: selectedScryfallCard.set?.toUpperCase() || 'MTG',
        quantity: parseInt(addQuantity, 10),
        price: price,
        colors: selectedScryfallCard.colors || selectedScryfallCard.color_identity || [],
        rarity: selectedScryfallCard.rarity || 'common',
        typeLine: selectedScryfallCard.type_line || '',
        imageUrl: imageUrl,
        isFoil: isFoil,
        addedAt: new Date().toISOString()
      });
    }

    setQueryName('');
    setSelectedScryfallCard(null);
    setAddQuantity(1);
    setIsFoil(false);
  };

  const handleDeleteCard = async (cardId) => {
    await deleteDoc(doc(db, 'cards', cardId));
  };

  // CSV Import with userId scoping
  const handleCsvImport = async () => {
    if (!csvText.trim() || !user) return;
    setImportStatus('Processing CSV data...');
    
    const lines = csvText.trim().split('\n');
    let addedCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.toLowerCase().startsWith('name') || line.toLowerCase().startsWith('card')) continue;

      const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
      const name = parts[0];
      const quantity = parseInt(parts[1], 10) || 1;
      const setName = parts[2] || 'Imported Set';
      const price = parseFloat(parts[3]) || 0.50;

      if (name) {
        await addDoc(collection(db, 'cards'), {
          userId: user.uid,
          name: name,
          setName: setName,
          setCode: 'CSV',
          quantity: quantity,
          price: price,
          colors: ['W', 'U', 'B', 'R', 'G'],
          rarity: 'rare',
          typeLine: 'Imported Card',
          imageUrl: 'https://cards.scryfall.io/back.jpg',
          isFoil: false,
          addedAt: new Date().toISOString()
        });
        addedCount++;
      }
    }

    setImportStatus(`Successfully imported ${addedCount} card entries!`);
    setCsvText('');
    setTimeout(() => setImportStatus(''), 4000);
  };

  const filteredCards = cards.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          c.setName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesColor = selectedColor === 'ALL' || (c.colors && c.colors.includes(selectedColor));
    const matchesRarity = selectedRarity === 'ALL' || c.rarity.toLowerCase() === selectedRarity.toLowerCase();
    return matchesSearch && matchesColor && matchesRarity;
  });

  const totalCardsCount = cards.reduce((acc, c) => acc + c.quantity, 0);
  const totalValue = cards.reduce((acc, c) => acc + (c.price * c.quantity), 0).toFixed(2);
  const offeredTotal = offeredCards.reduce((acc, c) => acc + (c.price * c.tradeQty), 0).toFixed(2);
  const requestedTotal = requestedCards.reduce((acc, c) => acc + (c.price * c.tradeQty), 0).toFixed(2);
  const tradeDelta = (offeredTotal - requestedTotal).toFixed(2);

  // AUTHENTICATION SCREEN FOR UNAUTHENTICATED USERS
  if (!user) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-gray-900 border border-gray-800 rounded-2xl p-8 space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex p-3 bg-indigo-600 rounded-xl shadow-lg shadow-indigo-500/30 mb-2">
              <Layers className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white">Goober Box</h1>
            <p className="text-sm text-gray-400">
              {isRegistering ? 'Create an account to start managing your collection' : 'Sign in to access your MTG collection'}
            </p>
          </div>

          <form onSubmit={handleAuth} className="space-y-4">
            <div>
              <label className="text-xs text-gray-400 font-medium">Email Address</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="planeswalker@magic.com"
                className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 mt-1"
              />
            </div>

            <div>
              <label className="text-xs text-gray-400 font-medium">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 mt-1"
              />
            </div>

            {authError && (
              <p className="text-xs text-red-400 font-medium">{authError}</p>
            )}

            <button
              type="submit"
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm rounded-xl transition shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2"
            >
              {isRegistering ? <UserPlus className="w-4 h-4" /> : <LogIn className="w-4 h-4" />}
              {isRegistering ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <div className="text-center">
            <button
              onClick={() => {
                setIsRegistering(!isRegistering);
                setAuthError('');
              }}
              className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
            >
              {isRegistering ? 'Already have an account? Sign in' : "Don't have an account? Register now"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans antialiased">
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600 rounded-lg shadow-lg shadow-indigo-500/30">
              <Layers className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                Goober box
              </h1>
              <p className="text-xs text-gray-400">Signed in as <span className="text-indigo-300">{user.email}</span></p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <nav className="flex bg-gray-800/80 p-1 rounded-xl border border-gray-700/50">
              <button
                onClick={() => setActiveTab('collection')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab === 'collection' ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Database className="w-4 h-4" /> Collection
              </button>
              <button
                onClick={() => setActiveTab('add')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab === 'add' ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Plus className="w-4 h-4" /> Add / Import
              </button>
              <button
                onClick={() => setActiveTab('trade')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab === 'trade' ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <ArrowLeftRight className="w-4 h-4" /> Trade Calculator
              </button>
            </nav>

            <button
              onClick={handleLogout}
              className="p-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-xl transition border border-red-500/20"
              title="Sign Out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {activeTab === 'collection' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-gray-900/90 border border-gray-800 p-5 rounded-2xl flex items-center gap-4">
                <div className="p-3 bg-indigo-500/10 text-indigo-400 rounded-xl">
                  <PackageCheck className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">Total Inventory</p>
                  <p className="text-2xl font-bold text-white">{totalCardsCount} <span className="text-xs text-gray-500">cards</span></p>
                </div>
              </div>

              <div className="bg-gray-900/90 border border-gray-800 p-5 rounded-2xl flex items-center gap-4">
                <div className="p-3 bg-emerald-500/10 text-emerald-400 rounded-xl">
                  <TrendingUp className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">Estimated Collection Value</p>
                  <p className="text-2xl font-bold text-emerald-400">${totalValue}</p>
                </div>
              </div>

              <div className="bg-gray-900/90 border border-gray-800 p-5 rounded-2xl flex items-center gap-4">
                <div className="p-3 bg-purple-500/10 text-purple-400 rounded-xl">
                  <Sparkles className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">Unique Titles</p>
                  <p className="text-2xl font-bold text-white">{cards.length}</p>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 p-4 rounded-2xl flex flex-col md:flex-row gap-4 justify-between items-center">
              <div className="relative w-full md:w-96">
                <Search className="w-4 h-4 absolute left-3 top-3 text-gray-500" />
                <input
                  type="text"
                  placeholder="Search card name or set..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl pl-9 pr-4 py-2 text-sm focus:outline-none focus:border-indigo-500 text-white"
                />
              </div>

              <div className="flex flex-wrap gap-3 w-full md:w-auto">
                <select
                  value={selectedColor}
                  onChange={(e) => setSelectedColor(e.target.value)}
                  className="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
                >
                  <option value="ALL">All Colors</option>
                  <option value="W">White</option>
                  <option value="U">Blue</option>
                  <option value="B">Black</option>
                  <option value="R">Red</option>
                  <option value="G">Green</option>
                </select>

                <select
                  value={selectedRarity}
                  onChange={(e) => setSelectedRarity(e.target.value)}
                  className="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
                >
                  <option value="ALL">All Rarities</option>
                  <option value="common">Common</option>
                  <option value="uncommon">Uncommon</option>
                  <option value="rare">Rare</option>
                  <option value="mythic">Mythic</option>
                </select>
              </div>
            </div>

            {loading ? (
              <div className="text-center py-20 text-gray-500">Loading your collection...</div>
            ) : filteredCards.length === 0 ? (
              <div className="text-center py-20 border border-dashed border-gray-800 rounded-2xl bg-gray-900/40">
                <p className="text-gray-400 font-medium">No Magic cards found in your account.</p>
                <button
                  onClick={() => setActiveTab('add')}
                  className="mt-4 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-500 transition"
                >
                  Add Cards Now
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {filteredCards.map((card) => (
                  <div key={card.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden group hover:border-gray-700 transition flex flex-col justify-between">
                    <div className="relative">
                      <img 
                        src={card.imageUrl || 'https://cards.scryfall.io/back.jpg'} 
                        alt={card.name} 
                        className="w-full h-auto object-cover"
                        loading="lazy"
                      />
                      <div className="absolute top-2 right-2 bg-gray-950/80 backdrop-blur text-xs px-2 py-1 rounded-lg font-bold border border-gray-700 text-indigo-300">
                        x{card.quantity}
                      </div>
                      {card.isFoil && (
                        <div className="absolute top-2 left-2 bg-gradient-to-r from-amber-400 to-yellow-200 text-gray-950 text-[10px] font-black px-1.5 py-0.5 rounded shadow">
                          FOIL
                        </div>
                      )}
                    </div>

                    <div className="p-3 space-y-2">
                      <div>
                        <h3 className="text-sm font-bold text-white line-clamp-1">{card.name}</h3>
                        <p className="text-xs text-gray-400">{card.setName}</p>
                      </div>

                      <div className="flex justify-between items-center text-xs">
                        {renderManaBadges(card.colors)}
                        <span className="font-semibold text-emerald-400">${(card.price || 0).toFixed(2)}</span>
                      </div>

                      <button
                        onClick={() => handleDeleteCard(card.id)}
                        className="w-full mt-2 flex items-center justify-center gap-1 text-xs py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'add' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl space-y-4">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Search className="w-5 h-5 text-indigo-400" /> Search & Quick Add
              </h2>
              <p className="text-xs text-gray-400">Type any card name to lookup live metadata from Scryfall.</p>

              <div className="relative">
                <input
                  type="text"
                  placeholder="e.g. Black Lotus, Sol Ring, Ragavan..."
                  value={queryName}
                  onChange={(e) => setQueryName(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                />

                {searchResults.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-gray-900 border border-gray-800 rounded-xl shadow-2xl max-h-60 overflow-y-auto z-50">
                    {searchResults.map((item) => (
                      <button
                        key={item}
                        onClick={() => handleSelectCardName(item)}
                        className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-indigo-600 hover:text-white transition border-b border-gray-800/50 last:border-none"
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {selectedScryfallCard && (
                <div className="p-4 bg-gray-950 border border-gray-800 rounded-xl space-y-4">
                  <div className="flex gap-4">
                    <img 
                      src={selectedScryfallCard.image_uris?.small || selectedScryfallCard.card_faces?.[0]?.image_uris?.small} 
                      alt={selectedScryfallCard.name} 
                      className="w-20 h-auto rounded-lg"
                    />
                    <div className="space-y-1">
                      <h4 className="font-bold text-white">{selectedScryfallCard.name}</h4>
                      <p className="text-xs text-gray-400">{selectedScryfallCard.set_name}</p>
                      <p className="text-xs text-emerald-400 font-semibold">
                        Market Price: ${selectedScryfallCard.prices?.usd || selectedScryfallCard.prices?.usd_foil || '0.50'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400">Qty:</label>
                      <input 
                        type="number" 
                        min="1" 
                        value={addQuantity} 
                        onChange={(e) => setAddQuantity(e.target.value)} 
                        className="w-16 bg-gray-900 border border-gray-800 rounded-lg px-2 py-1 text-sm text-center text-white"
                      />
                    </div>

                    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={isFoil} 
                        onChange={(e) => setIsFoil(e.target.checked)} 
                        className="rounded bg-gray-900 border-gray-700 text-indigo-600 focus:ring-indigo-500"
                      />
                      Foil Finish
                    </label>
                  </div>

                  <button
                    onClick={handleAddCardToCollection}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm rounded-xl transition shadow-lg shadow-indigo-600/20"
                  >
                    Add to Personal Collection
                  </button>
                </div>
              )}
            </div>

            <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl space-y-4">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Upload className="w-5 h-5 text-indigo-400" /> CSV Collection Import
              </h2>
              <p className="text-xs text-gray-400">
                Paste raw CSV content to add card lists. Format: <code className="text-indigo-300">Name, Quantity, Set, Price</code>
              </p>

              <textarea
                rows="8"
                placeholder="Lightning Bolt, 4, Secret Lair, 2.50&#10;Counterspell, 2, Dominaria, 1.20&#10;Sol Ring, 1, Commander, 1.80"
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                className="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-xs font-mono text-gray-200 focus:outline-none focus:border-indigo-500"
              />

              {importStatus && (
                <p className="text-xs font-semibold text-emerald-400">{importStatus}</p>
              )}

              <button
                onClick={handleCsvImport}
                className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-white font-medium text-sm rounded-xl transition border border-gray-700"
              >
                Import CSV Entries
              </button>
            </div>
          </div>
        )}

        {activeTab === 'trade' && (
          <div className="space-y-6">
            <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl flex flex-col md:flex-row justify-between items-center gap-4">
              <div>
                <h2 className="text-lg font-bold text-white">Trade Value Balancer</h2>
                <p className="text-xs text-gray-400">Select cards from your collection to offer and balance market prices.</p>
              </div>

              <div className="flex items-center gap-4 bg-gray-950 px-4 py-2 rounded-xl border border-gray-800">
                <div className="text-center">
                  <p className="text-[10px] text-gray-500 uppercase font-bold">You Offer</p>
                  <p className="text-lg font-bold text-indigo-400">${offeredTotal}</p>
                </div>
                <span className="text-gray-600 font-bold">VS</span>
                <div className="text-center">
                  <p className="text-[10px] text-gray-500 uppercase font-bold">You Request</p>
                  <p className="text-lg font-bold text-purple-400">${requestedTotal}</p>
                </div>
                <div className="border-l border-gray-800 pl-4 text-center">
                  <p className="text-[10px] text-gray-500 uppercase font-bold">Difference</p>
                  <p className={`text-lg font-bold ${tradeDelta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    ${tradeDelta}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl space-y-4">
              <h3 className="text-sm font-bold text-gray-300">Select Cards from Collection to Add to Trade</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 max-h-64 overflow-y-auto pr-2">
                {cards.map((card) => (
                  <button
                    key={card.id}
                    onClick={() => {
                      setOfferedCards((prev) => [
                        ...prev,
                        { ...card, tradeQty: 1 }
                      ]);
                    }}
                    className="bg-gray-950 p-2 rounded-xl border border-gray-800 hover:border-indigo-500 text-left transition text-xs"
                  >
                    <p className="font-bold text-white truncate">{card.name}</p>
                    <p className="text-emerald-400 font-semibold">${card.price?.toFixed(2)}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl space-y-4">
              <h3 className="text-sm font-bold text-indigo-400">Offered Cards ({offeredCards.length})</h3>
              {offeredCards.length === 0 ? (
                <p className="text-xs text-gray-500 italic">No cards added to the offer side yet.</p>
              ) : (
                <div className="space-y-2">
                  {offeredCards.map((item, idx) => (
                    <div key={idx} className="flex justify-between items-center bg-gray-950 p-3 rounded-xl border border-gray-800 text-xs">
                      <span className="font-medium text-white">{item.name}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-emerald-400 font-bold">${item.price?.toFixed(2)}</span>
                        <button
                          onClick={() => setOfferedCards(offeredCards.filter((_, i) => i !== idx))}
                          className="text-red-400 hover:text-red-300"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}