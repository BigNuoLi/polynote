import {
    arrayCodec,
    Codec,
    CodecContainer,
    combined,
    DataReader,
    DataWriter,
    discriminated,
    int32,
    str,
    uint8
} from './codec'
import match from "../util/match";

export abstract class DataType extends CodecContainer {
    static codec: Codec<DataType>;
    static codecs: typeof DataType[];
    static delegatedCodec = {
        // Need to make a delegator here, because DataType.codec doesn't exist yet and forms recursive knots with i.e. StructField.
        // This defers evaluating DataType.codec, tying the knot
        encode: (value: DataType, writer: DataWriter) => DataType.codec.encode(value, writer),
        decode: (reader: DataReader): DataType => DataType.codec.decode(reader)
    };
    static msgTypeId: number;
    isNumeric = false;

    // NOTE: renamed from `name()` -> `typeName()` since typescript complains about overriding `Function.name`
    typeName(): string{
        return DataType.typeName(this);
    }
    static typeName(inst: DataType): string { return (inst.constructor as typeof DataType).typeName(inst)}

    abstract decodeBuffer(reader: DataReader): any // any way to type this better?

}

// Factory that creates DataTypes as Singleton classes that are instances of their own class constructor
// Thus, they have access to both static and instance properties defined in SDT.
// NOTE: in order for this trick to work, we can't have any static methods - Object.assign only assigns properties!
function SingletonDataType<T>(msgTypeId: number, readBuf: (reader: DataReader) => T, name: string, isNumeric: boolean = false): DataType & typeof DataType {
    class SDT extends DataType {
        static msgTypeId = msgTypeId;
        static typeName = () => { return name };
        static codec: Codec<SDT>;

        decodeBuffer(reader: DataReader) {
            return readBuf(reader);
        }
        static isNumeric = isNumeric;
    }
    const sdt = new SDT();

    SDT.codec = {
        encode: (value: SDT, writer: DataWriter) => {},
        decode: (reader: DataReader): SDT => sdt,
    };

    // NOTE: this only assigns properties on SDT - so static methods *won't go through*.
    const result = Object.assign(sdt, SDT);
    Object.freeze(result);
    return result;
}

export const ByteType = SingletonDataType(0, reader => reader.readUint8(), 'byte');
export const BoolType = SingletonDataType(1, reader => reader.readBoolean(), 'boolean');
export const ShortType = SingletonDataType(2, reader => reader.readInt16(), 'int2', true);
export const IntType = SingletonDataType(3, reader => reader.readInt32(), 'int4', true);
export const LongType = SingletonDataType(4, reader => reader.readInt64(), 'int8', true);
export const UnsafeLongType = SingletonDataType(4, reader => reader.readUnsafeInt64(), 'int8', true);
export const FloatType = SingletonDataType(5, reader => reader.readFloat32(), 'float4', true);
export const DoubleType = SingletonDataType(6, reader => reader.readFloat64(), 'float8', true);
export const BinaryType = SingletonDataType(7, reader => reader.readBuffer(), 'binary');
export const StringType = SingletonDataType(8, reader => reader.readString(), 'string');

export const NumericTypes: DataType[] = [ShortType, IntType, LongType, UnsafeLongType, FloatType, DoubleType];
Object.freeze(NumericTypes);

export class StructField {
    static codec = combined(str, DataType.delegatedCodec).to(StructField);

    static unapply(inst: StructField): ConstructorParameters<typeof StructField> {
        return [inst.name, inst.dataType];
    }

    constructor(readonly name: string, readonly dataType: DataType) {
        Object.freeze(this);
    }
}

export class StructType extends DataType {
    static codec = combined(arrayCodec(int32, StructField.codec)).to(StructType);
    static get msgTypeId() { return 9; }
    static typeName(inst: StructType) { return 'struct'; }
    static unapply(inst: StructType): ConstructorParameters<typeof StructType> {
        return [inst.fields];
    }

    typeName() { return StructType.typeName(this); }

    constructor(readonly fields: StructField[]) {
        super();
        Object.freeze(this);
    }

    decodeBuffer(reader: DataReader) {
        const obj: Record<string, any> = {};
        this.fields.forEach(field => {
            obj[field.name] = field.dataType.decodeBuffer(reader)
        });
        return obj;
    }

    /**
     * Recursively inspect (and possibly replace) every data type in this StructType, returning a new StructType
     * with updated types.
     *
     * @param fn A "partial" function which receives every data type present in this struct, and may return a replacement
     *           data type (which aborts further recursion) or `undefined`, which leaves that data type unchanged (but
     *           will further recurse into it if it is a struct, array, map, or optional)
     */
    replaceType(fn: (typ: DataType) => DataType | undefined): StructType {
        function newType(type: DataType): DataType {
            return fn(type) || match(type)
                .when(StructType, fields => new StructType(fields.map(field => new StructField(field.name, newType(field.dataType)))))
                .when(ArrayType, elementType => new ArrayType(fn(elementType) || elementType))
                .when(MapType, (keyType, valueType) => new MapType(fn(keyType) || keyType, fn(valueType) || valueType))
                .when(OptionalType, underlying => new OptionalType(fn(underlying) || underlying))
                .otherwise(type)
        }
        return new StructType(this.fields.map(
            field => new StructField(field.name, newType(field.dataType))
        ))
    }

    fieldType(fieldName: string): DataType | undefined {
        const field = this.fields.find(field => field.name === fieldName);
        return field?.dataType
    }
}

export class OptionalType extends DataType {
    static codec = combined(DataType.delegatedCodec).to(OptionalType);
    static get msgTypeId() { return 10; }
    static typeName(inst: OptionalType) { return `${(inst.element.constructor as typeof DataType).typeName(inst.element)}?`}
    static unapply(inst: OptionalType): ConstructorParameters<typeof OptionalType> {
        return [inst.element];
    }

    typeName() { return OptionalType.typeName(this); }

    constructor(readonly element: DataType) {
        super();
        this.isNumeric = element.isNumeric;
        Object.freeze(this);
    }

    decodeBuffer(reader: DataReader) {
        if(reader.readBoolean()) {
            return this.element.decodeBuffer(reader);
        }
        return null;
    }
}

export class ArrayType extends DataType {
    static codec = combined(DataType.delegatedCodec).to(ArrayType);
    static get msgTypeId() { return 11; }
    static typeName(inst: ArrayType) { return `[${(inst.element.constructor as typeof DataType).typeName(inst.element)}]`}
    static unapply(inst: ArrayType): ConstructorParameters<typeof ArrayType> {
        return [inst.element];
    }

    typeName() { return ArrayType.typeName(this); }

    constructor(readonly element: DataType) {
        super();
        Object.freeze(this);
    }

    decodeBuffer(reader: DataReader) {
        const len = reader.readInt32();
        const result = [];
        for (let i = 0; i < len; i++) {
            result[i] = this.element.decodeBuffer(reader);
        }
        return result;
    }
}

export const DateType = SingletonDataType(12, buffer => {throw "TODO"}, 'date');
export const TimestampType = SingletonDataType(13, buffer => {throw "TODO"}, 'timestamp');
export const TypeType = SingletonDataType(14, buffer => buffer.readString(), 'type');

export class MapType extends DataType {
    static codec = combined(DataType.delegatedCodec, DataType.delegatedCodec).to(MapType);
    static get msgTypeId() { return 15; }
    static typeName(inst: MapType) { return `map[${inst.keyType.typeName()} -> ${inst.valueType.typeName()}]`}
    static unapply(inst: MapType): ConstructorParameters<typeof MapType>{
        return [inst.keyType, inst.valueType];
    }

    typeName() { return MapType.typeName(this); }

    constructor(readonly keyType: DataType, readonly valueType: DataType) {
        super();
        Object.freeze(this);
    }

    decodeBuffer(reader: DataReader) {
        const len = reader.readInt32();
        const result: [string, any][] = [];
        for (let i = 0; i < len; i++) {
            result[i] = [this.keyType.decodeBuffer(reader), this.valueType.decodeBuffer(reader)]
        }
        return new Map<string, any>(result);
    }
}

DataType.codecs = [
    ByteType,     //  0
    BoolType,     //  1
    ShortType,    //  2
    IntType,      //  3
    LongType,     //  4
    FloatType,    //  5
    DoubleType,   //  6
    BinaryType,   //  7
    StringType,   //  8
    StructType,   //  9
    OptionalType, // 10
    ArrayType,    // 11
    DateType,     // 12
    TimestampType, // 13
    TypeType,     // 14
    MapType,      // 15
];

DataType.codec = discriminated(
    uint8,
    (msgTypeId) => DataType.codecs[msgTypeId].codec,
    (result) => (result.constructor as typeof DataType).msgTypeId
);