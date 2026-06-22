import prisma from '../db/db.js';

async function main() {
    try {
        await prisma.$connect();

        console.log('✅ Database connected');

        const result = await prisma.$queryRaw`SELECT NOW()`;

        console.log(result);

        await prisma.$disconnect();
    } catch (err) {
        console.error(err);
    }
}

main();