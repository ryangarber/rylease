import { promisify } from "node:util";
import { crc32, deflateRaw } from "node:zlib";

const deflate = promisify(deflateRaw);

const LIMIT = 0xffff_ffff;

/**
 * Zips files, deflated, into one buffer. Without ZIP64, the archive and each
 * file must stay under 4 GiB.
 */
export async function zip(
	entries: readonly { name: string; content: Uint8Array }[],
): Promise<Buffer> {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name.replaceAll("\\", "/"));
		const data = await deflate(entry.content);
		if (entry.content.length >= LIMIT || offset + data.length >= LIMIT) {
			throw new Error(`'${entry.name}' is too large to zip (4 GiB at most)`);
		}
		const crc = crc32(entry.content);
		// Version 2.0, UTF-8 names, deflate, no timestamp (1980-01-01).
		const fields = (header: Buffer, at: number) => {
			header.writeUInt16LE(20, at);
			header.writeUInt16LE(0x0800, at + 2);
			header.writeUInt16LE(8, at + 4);
			header.writeUInt16LE(0, at + 6);
			header.writeUInt16LE(0x21, at + 8);
			header.writeUInt32LE(crc, at + 10);
			header.writeUInt32LE(data.length, at + 14);
			header.writeUInt32LE(entry.content.length, at + 18);
			header.writeUInt16LE(name.length, at + 22);
			header.writeUInt16LE(0, at + 24);
		};
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		fields(local, 4);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt16LE(20, 4); // made by
		fields(record, 6);
		record.writeUInt32LE(offset, 42);
		central.push(record, name);
		parts.push(local, name, data);
		offset += local.length + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}
