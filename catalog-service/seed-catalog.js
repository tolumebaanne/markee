require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');

async function seed() {
    const uri = process.env.MONGODB_URI;
    if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }
    try {
        await mongoose.connect(uri);
        
        const ProductSchema = new mongoose.Schema({
            sellerId: mongoose.Schema.Types.ObjectId,
            title: String, 
            description: String, 
            category: String, 
            price: Number, 
            images: [String], 
            status: String
        });
        
        // Define model if not exists to avoid OverwriteModelError in some envs
        const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);
        
        await Product.deleteMany({});
        
        await Product.insertMany([
            {
                sellerId: new mongoose.Types.ObjectId(),
                title: "Noise Cancelling Headphones",
                description: "Premium over-ear headphones with active noise cancellation and 30-hour battery life.",
                category: "Electronics",
                price: 29900,
                images: ["https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500&q=80"],
                status: "active"
            },
            {
                sellerId: new mongoose.Types.ObjectId(),
                title: "Leather Minimalist Watch",
                description: "A sleek, low-profile watch with a genuine leather strap.",
                category: "Accessories",
                price: 14500,
                images: ["https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=500&q=80"],
                status: "active"
            },
            {
                sellerId: new mongoose.Types.ObjectId(),
                title: "Mechanical Keyboard Pro",
                description: "RGB mechanical keyboard with tactile brown switches.",
                category: "Electronics",
                price: 12000,
                images: ["https://images.unsplash.com/photo-1595225476474-87563907a212?w=500&q=80"],
                status: "active"
            },
            {
                sellerId: new mongoose.Types.ObjectId(),
                title: "Ceramic Coffee Mug",
                description: "Hand-crafted ceramic mug perfect for your morning brew.",
                category: "Home",
                price: 2400,
                images: ["https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=500&q=80"],
                status: "active"
            }
        ]);
        
        console.log("Database Seeded Successfully!");
        process.exit(0);
    } catch(err) {
        console.error("Seed Error:", err);
        process.exit(1);
    }
}
seed();
