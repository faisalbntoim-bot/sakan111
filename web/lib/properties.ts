// Canonical property list shared by the new /booking routes.
//
// The interactive SPA (public/vendor/sakan-design/app.js) keeps its
// own copy of these 15 items so it can render fully client-side without
// pulling in a Next.js dependency graph; the two lists MUST stay in
// sync when either is edited. Ordering here matches the SPA array
// exactly — the numeric index in that array is the URL id used by the
// booking flow (0..14).

export type PropertyRecord = {
  id: string;
  name: string;
  neighborhood: string;
  city: string;
  category: string;
  area: number;
  rooms: number;
  bath: number;
  dailyRate: number;
  cleaning: number;
  rating: number;
  maxGuests: number;
  photoIndex: number; // 1..5 → maps to /vendor/sakan-design/photos/... in the SPA gallery
  shortTerm: boolean;
  booked: number[]; // day-of-month numbers to disable on the calendar
  desc: string;
};

// Same 15 records the SPA renders. Only the fields the booking flow
// actually uses live here — the rest stay in the SPA. If new fields
// become necessary later, mirror them from the SPA source.
export const PROPERTIES: PropertyRecord[] = [
  { id:'0',  name:'شقة 3 غرف',      neighborhood:'حي الملقا',   city:'الرياض', category:'شقة',      area:180, rooms:3, bath:2, dailyRate:260,  cleaning:120, rating:4.8, maxGuests:6,  photoIndex:1, shortTerm:true,  booked:[2,3,4,11,12,18],       desc:'شقة عصرية بحي الملقا، تشطيب راقٍ وموقع قريب من الخدمات والمدارس، مناسبة للعائلات الصغيرة والمتوسطة.' },
  { id:'1',  name:'شقة 2 غرف',      neighborhood:'حي النرجس',   city:'الرياض', category:'شقة',      area:130, rooms:2, bath:1, dailyRate:170,  cleaning:100, rating:4.6, maxGuests:4,  photoIndex:2, shortTerm:true,  booked:[0,1,7,8,9,20,21],      desc:'شقة مريحة بحي النرجس، إضاءة طبيعية جيدة وتصميم عملي، قريبة من المسارات الرئيسية.' },
  { id:'2',  name:'دوبلكس 4 غرف',   neighborhood:'حي الياسمين', city:'الرياض', category:'دوبلكس',   area:260, rooms:4, bath:3, dailyRate:390,  cleaning:180, rating:4.3, maxGuests:8,  photoIndex:3, shortTerm:false, booked:[],                     desc:'دوبلكس واسع بحي الياسمين مع مدخلين مستقلين، مناسب للعائلات الكبيرة، تشطيبات فندقية.' },
  { id:'3',  name:'استوديو مفروش',   neighborhood:'حي العارض',   city:'الرياض', category:'استوديو',  area:85,  rooms:1, bath:1, dailyRate:120,  cleaning:70,  rating:4.9, maxGuests:2,  photoIndex:4, shortTerm:true,  booked:[5,6,14,15,16,25],      desc:'استوديو مفروش بالكامل بحي العارض، مثالي للأفراد والموظفين، خدمات صيانة شاملة.' },
  { id:'4',  name:'فيلا 5 غرف',     neighborhood:'حي الملقا',   city:'الرياض', category:'فيلا',     area:420, rooms:5, bath:4, dailyRate:650,  cleaning:250, rating:4.7, maxGuests:10, photoIndex:5, shortTerm:true,  booked:[9,10,17,18,19,28,29],  desc:'فيلا مستقلة بحي الملقا بحديقة خاصة ومسبح، تصميم عصري وخصوصية كاملة.' },
  { id:'5',  name:'شقة 2 غرف',      neighborhood:'حي النرجس',   city:'الرياض', category:'شقة',      area:120, rooms:2, bath:1, dailyRate:150,  cleaning:100, rating:4.5, maxGuests:4,  photoIndex:2, shortTerm:false, booked:[],                     desc:'شقة اقتصادية بحي النرجس بتصميم بسيط وعملي، قريبة من محطات المواصلات.' },
  { id:'6',  name:'أرض سكنية',       neighborhood:'حي العارض',   city:'الرياض', category:'أرض',      area:625, rooms:0, bath:0, dailyRate:0,    cleaning:0,   rating:4.4, maxGuests:0,  photoIndex:1, shortTerm:false, booked:[],                     desc:'أرض سكنية بحي العارض على شارع نافذ، مخطط معتمد وصك إلكتروني، مناسبة للبناء أو الاستثمار طويل المدى.' },
  { id:'7',  name:'شقة 4 غرف',      neighborhood:'حي القيروان', city:'الرياض', category:'شقة',      area:210, rooms:4, bath:3, dailyRate:290,  cleaning:130, rating:4.7, maxGuests:8,  photoIndex:2, shortTerm:true,  booked:[3,4,5,13,14],          desc:'شقة عائلية واسعة بحي القيروان، تشطيب فاخر وصالة مستقلة، قريبة من المدارس والحدائق.' },
  { id:'8',  name:'فيلا 6 غرف',     neighborhood:'حي حطين',     city:'الرياض', category:'فيلا',     area:480, rooms:6, bath:5, dailyRate:850,  cleaning:300, rating:4.9, maxGuests:12, photoIndex:1, shortTerm:true,  booked:[8,9,10,20,21],         desc:'فيلا فاخرة بحي حطين مع مسبح وحديقة ومجلس خارجي، خصوصية تامة وموقع مميّز غرب الرياض.' },
  { id:'9',  name:'دوبلكس 5 غرف',   neighborhood:'حي الياسمين', city:'الرياض', category:'دوبلكس',   area:300, rooms:5, bath:4, dailyRate:430,  cleaning:200, rating:4.5, maxGuests:10, photoIndex:3, shortTerm:true,  booked:[1,2,15,16],            desc:'دوبلكس حديث بحي الياسمين بمدخلين مستقلين وسطح خاص، مناسب للعائلات الكبيرة.' },
  { id:'10', name:'أرض تجارية',      neighborhood:'حي النرجس',   city:'الرياض', category:'أرض',      area:900, rooms:0, bath:0, dailyRate:0,    cleaning:0,   rating:4.6, maxGuests:0,  photoIndex:1, shortTerm:false, booked:[],                     desc:'أرض تجارية على شارع تجاري رئيسي بحي النرجس، صك إلكتروني ومخطط معتمد — فرصة استثمارية للبيع.' },
  { id:'11', name:'استوديو مفروش',   neighborhood:'حي الملقا',   city:'الرياض', category:'استوديو',  area:70,  rooms:1, bath:1, dailyRate:150,  cleaning:80,  rating:4.8, maxGuests:2,  photoIndex:4, shortTerm:true,  booked:[6,7,17,18,19],         desc:'استوديو مفروش أنيق بحي الملقا، جاهز للسكن الفوري، مثالي للأفراد والزيارات القصيرة.' },
  { id:'12', name:'بنتهاوس فاخر',    neighborhood:'حي الياسمين', city:'الرياض', category:'شقة',      area:340, rooms:4, bath:4, dailyRate:1200, cleaning:350, rating:4.9, maxGuests:8,  photoIndex:5, shortTerm:true,  booked:[2,3,12,13,22,23],      desc:'بنتهاوس فاخر بالطابق الأخير — تراس خاص وإطلالة بانورامية على المدينة، تشطيبات فندقية ومسبح خاص.' },
  { id:'13', name:'أرض سكنية',       neighborhood:'حي القيروان', city:'الرياض', category:'أرض',      area:750, rooms:0, bath:0, dailyRate:0,    cleaning:0,   rating:4.7, maxGuests:0,  photoIndex:1, shortTerm:false, booked:[],                     desc:'أرض سكنية بحي القيروان على شارعين، مخطط معتمد وصك إلكتروني — موقع استثماري مميّز للبناء أو البيع.' },
];

export function getProperty(id: string): PropertyRecord | undefined {
  return PROPERTIES.find(p => p.id === id);
}
